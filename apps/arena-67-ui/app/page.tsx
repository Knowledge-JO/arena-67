import { Nav } from '@/components/landing/Nav';
import { Hero } from '@/components/landing/Hero';
import { Tape } from '@/components/landing/Tape';
import { PaintMarket } from '@/components/landing/PaintMarket';
import { BeatMarket } from '@/components/landing/BeatMarket';
import { Product } from '@/components/landing/Product';
import { Outro } from '@/components/landing/Outro';

export default function Landing() {
  return (
    <div className="min-h-dvh bg-paper font-display text-ink antialiased selection:bg-ink selection:text-paper">
      <Nav />
      <main>
        <Hero />
        <Tape />
        <PaintMarket />
        <BeatMarket />
        <Product />
        <Outro />
      </main>
    </div>
  );
}