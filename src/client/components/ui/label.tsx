import * as React from 'react';
import { cn } from '@/lib/utils';

const Label = React.forwardRef<HTMLLabelElement, React.LabelHTMLAttributes<HTMLLabelElement>>(
  ({ className, ...props }, ref) => {
    return (
      <label
        ref={ref}
        className={cn('text-xs text-muted-foreground mb-1 block', className)}
        {...props}
      />
    );
  }
);
Label.displayName = 'Label';

export { Label };
