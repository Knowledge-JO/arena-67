import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { resolve } from 'node:path';
import { EMBEDDING_DIMENSIONS } from '../database/schema';

type Extractor = (
  input: string | string[],
  opts: { pooling: 'mean'; normalize: boolean },
) => Promise<{ tolist(): number[][] }>;

const MODEL = 'Xenova/all-MiniLM-L6-v2';

/**
 * Local sentence embeddings, for semantic memory across conversations.
 *
 * Local because OpenServ serves no embeddings — its catalogue has none and
 * `/v1/embeddings` is a 404 — and a second hosted provider would mean another
 * key and another network dependency on a path that runs every turn. The
 * model is 384-dimensional, ~25MB, and embeds a message in milliseconds.
 *
 * Loading is the catch: the first run downloads the model, measured at over
 * forty seconds. So it loads in the background and never blocks startup, and
 * until it is ready `embed` returns null — messages are still saved, just
 * without a vector, and recall simply finds nothing yet. Memory being briefly
 * unavailable is far better than the backend taking a minute to come up.
 */
@Injectable()
export class EmbeddingService implements OnModuleInit {
  private readonly log = new Logger(EmbeddingService.name);
  private extractor: Extractor | null = null;
  private loading: Promise<void> | null = null;

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    void this.load();
  }

  get ready(): boolean {
    return this.extractor !== null;
  }

  private load(): Promise<void> {
    if (this.loading) return this.loading;
    this.loading = (async () => {
      const started = Date.now();
      try {
        const tf = await import('@huggingface/transformers');
        tf.env.cacheDir = resolve(this.config.get<string>('MODEL_CACHE_DIR') ?? './.data/models');
        this.extractor = (await tf.pipeline('feature-extraction', MODEL)) as unknown as Extractor;
        this.log.log(`embedding model ready in ${Date.now() - started}ms`);
      } catch (err) {
        // Recoverable: a later call retries the load.
        this.loading = null;
        this.log.warn(`embedding model failed to load: ${(err as Error).message}`);
      }
    })();
    return this.loading;
  }

  /** A normalised vector, or null if the model is not ready yet. */
  async embed(text: string): Promise<number[] | null> {
    if (!this.extractor) {
      void this.load();
      return null;
    }
    // Long messages are truncated by the model anyway; trimming first keeps
    // the tokenizer from doing pointless work on a pasted essay.
    const out = await this.extractor(text.slice(0, 2000), { pooling: 'mean', normalize: true });
    const vec = out.tolist()[0];
    return vec?.length === EMBEDDING_DIMENSIONS ? vec : null;
  }
}
