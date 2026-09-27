import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { and, asc, cosineDistance, desc, eq, isNotNull, ne, sql } from 'drizzle-orm';
import { DRIZZLE } from '../database/database.constants';
import { dbOf, type Database } from '../database/database.module';
import { conversations, messages } from '../database/schema';
import { EmbeddingService } from './embedding.service';

export interface StoredTurn {
  role: 'user' | 'assistant';
  content: string;
  step?: unknown;
  toolsUsed?: string[];
}

export interface Memory {
  content: string;
  role: 'user' | 'assistant';
  conversationId: string;
  createdAt: Date;
  similarity: number;
}

/** Below this cosine similarity a "memory" is noise, not recall. */
const RECALL_FLOOR = 0.3;

/**
 * Conversations, their messages, and semantic recall across them.
 *
 * Every query here is scoped by user id, and recall is the one that matters
 * most: it searches across conversations, so it is the path by which one
 * user's words could surface in another's chat. The owner filter is applied in
 * the query itself, not after, and `messages.user_id` is denormalised onto the
 * row precisely so that filter cannot be forgotten behind a join.
 */
@Injectable()
export class ConversationService {
  private readonly log = new Logger(ConversationService.name);
  private readonly db: Database;

  constructor(
    @Inject(DRIZZLE) handle: unknown,
    private readonly embeddings: EmbeddingService,
  ) {
    this.db = dbOf(handle);
  }

  list(userId: string) {
    return this.db
      .select({
        id: conversations.id,
        title: conversations.title,
        updatedAt: conversations.updatedAt,
      })
      .from(conversations)
      .where(eq(conversations.userId, userId))
      .orderBy(desc(conversations.updatedAt))
      .limit(100);
  }

  async create(userId: string): Promise<{ id: string; title: string }> {
    const [row] = await this.db
      .insert(conversations)
      .values({ userId })
      .returning({ id: conversations.id, title: conversations.title });
    return row;
  }

  /** Throws unless this conversation belongs to this user. */
  async assertOwned(userId: string, conversationId: string): Promise<void> {
    const row = await this.db.query.conversations.findFirst({
      where: and(eq(conversations.id, conversationId), eq(conversations.userId, userId)),
      columns: { id: true },
    });
    // Not found and not yours are the same answer, so ids are not probeable.
    if (!row) throw new NotFoundException('Conversation not found.');
  }

  async messagesOf(userId: string, conversationId: string) {
    await this.assertOwned(userId, conversationId);
    return this.db
      .select({
        id: messages.id,
        role: messages.role,
        content: messages.content,
        step: messages.step,
        toolsUsed: messages.toolsUsed,
        createdAt: messages.createdAt,
      })
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(asc(messages.createdAt));
  }

  /** The last few turns, oldest first, for the model's immediate context. */
  async recent(userId: string, conversationId: string, limit = 12) {
    await this.assertOwned(userId, conversationId);
    const rows = await this.db
      .select({ role: messages.role, content: messages.content, step: messages.step })
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(desc(messages.createdAt))
      .limit(limit);
    return rows.reverse().map((r) => ({
      role: r.role as 'user' | 'assistant',
      content: r.content,
      stepKind: ((r.step as { kind?: string } | null)?.kind ?? null) as string | null,
    }));
  }

  async append(userId: string, conversationId: string, turn: StoredTurn): Promise<void> {
    await this.assertOwned(userId, conversationId);
    const embedding = await this.embeddings.embed(turn.content);

    await this.db.insert(messages).values({
      conversationId,
      userId,
      role: turn.role,
      content: turn.content,
      step: (turn.step ?? null) as never,
      toolsUsed: turn.toolsUsed ?? [],
      embedding,
    });

    // A fresh conversation takes its title from the first thing the user said.
    await this.db
      .update(conversations)
      .set({
        updatedAt: new Date(),
        ...(turn.role === 'user'
          ? {
              title: sql`CASE WHEN ${conversations.title} = 'New conversation'
                THEN ${turn.content.slice(0, 60)} ELSE ${conversations.title} END`,
            }
          : {}),
      })
      .where(eq(conversations.id, conversationId));
  }

  /**
   * Past messages from *this user's other conversations* that resemble the
   * query.
   *
   * The current conversation is excluded — its recent turns are already in
   * context, and recalling them again just duplicates them. Results below
   * RECALL_FLOOR are dropped: a weak match presented as memory invites the
   * model to build on something that was never really said.
   */
  async recall(
    userId: string,
    query: string,
    excludeConversationId: string,
    limit = 4,
  ): Promise<Memory[]> {
    const q = await this.embeddings.embed(query);
    if (!q) return [];

    const distance = cosineDistance(messages.embedding, q);
    const rows = await this.db
      .select({
        content: messages.content,
        role: messages.role,
        conversationId: messages.conversationId,
        createdAt: messages.createdAt,
        distance,
      })
      .from(messages)
      .where(
        and(
          eq(messages.userId, userId),
          ne(messages.conversationId, excludeConversationId),
          isNotNull(messages.embedding),
        ),
      )
      .orderBy(asc(distance))
      .limit(limit);

    return rows
      .map((r) => ({
        content: r.content,
        role: r.role,
        conversationId: r.conversationId,
        createdAt: r.createdAt,
        similarity: 1 - Number(r.distance),
      }))
      .filter((m) => m.similarity >= RECALL_FLOOR);
  }
}
