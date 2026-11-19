import { cn } from '@/lib/utils';

export function BrandMark({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex size-9 items-center justify-center rounded-lg bg-[oklch(0.83_0.07_75)] font-display text-lg font-semibold text-[oklch(0.25_0.05_335)]',
        className,
      )}
      aria-hidden
    >
      O
    </span>
  );
}

export function BrandName({ className }: { className?: string }) {
  return (
    <span className={cn('leading-tight', className)}>
      <span className="block font-display text-[17px] font-semibold tracking-tight">Oliver Hub</span>
      <span className="block text-[11px] uppercase tracking-[0.14em] opacity-60">WhatsApp</span>
    </span>
  );
}
