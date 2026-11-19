import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';
import { cn } from '@/lib/utils';

const badgeVariants = cva('inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold whitespace-nowrap', {
  variants: {
    tone: {
      neutral: 'bg-muted text-muted-foreground',
      brand: 'bg-secondary text-secondary-foreground',
      success: 'bg-success-soft text-[oklch(0.4_0.1_155)]',
      warning: 'bg-warning-soft text-[oklch(0.45_0.11_60)]',
      danger: 'bg-danger-soft text-[oklch(0.45_0.17_25)]',
    },
  },
  defaultVariants: { tone: 'neutral' },
});

export function Badge({ className, tone, ...props }: React.HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}
