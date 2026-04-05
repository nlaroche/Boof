import { useEffect, useRef } from 'react';
import { ansiToHtml } from '../lib/ansi';

export function AgentOutput({ lines }: { lines: string[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const shouldAutoScroll = useRef(true);

  useEffect(() => {
    const el = containerRef.current;
    if (el && shouldAutoScroll.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [lines]);

  const handleScroll = () => {
    const el = containerRef.current;
    if (el) {
      const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
      shouldAutoScroll.current = isAtBottom;
    }
  };

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      className="flex-1 overflow-y-auto bg-background p-3 font-mono text-sm leading-relaxed text-foreground"
    >
      {lines.length === 0 ? (
        <div className="text-muted-foreground italic">No output yet. Send a command to get started.</div>
      ) : (
        lines.map((line, i) => (
          <div
            key={i}
            className="whitespace-pre-wrap break-all"
            dangerouslySetInnerHTML={{ __html: ansiToHtml(line) }}
          />
        ))
      )}
    </div>
  );
}
