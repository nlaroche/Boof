import { useState, useRef, useEffect } from 'react';
import { Textarea } from './ui/textarea';
import { Button } from './ui/button';
import { cn } from '@/lib/utils';

interface Props {
  onSend: (text: string) => void;
  onMicToggle?: () => void;
  isListening?: boolean;
  speechSupported?: boolean;
  externalText?: string;
  disabled?: boolean;
}

export function CommandInput({ onSend, onMicToggle, isListening, speechSupported, externalText, disabled }: Props) {
  const [text, setText] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (externalText !== undefined) {
      setText(externalText);
    }
  }, [externalText]);

  useEffect(() => {
    const el = textareaRef.current;
    if (el) {
      el.style.height = 'auto';
      el.style.height = Math.min(el.scrollHeight, 120) + 'px';
    }
  }, [text]);

  const handleSend = () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    onSend(trimmed);
    setText('');
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="flex items-end gap-2 p-3 bg-card border-t border-border shrink-0">
      <Textarea
        ref={textareaRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Tell it what to do..."
        disabled={disabled}
        rows={1}
        className="flex-1 min-h-[44px] py-2.5"
      />
      {speechSupported && (
        <Button
          variant={isListening ? 'destructive' : 'secondary'}
          size="icon"
          onClick={onMicToggle}
          className={cn(
            'min-w-[44px] min-h-[44px]',
            isListening && 'animate-pulse'
          )}
        >
          <svg viewBox="0 0 24 24" className="w-5 h-5" fill="currentColor">
            <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm-1-9c0-.55.45-1 1-1s1 .45 1 1v6c0 .55-.45 1-1 1s-1-.45-1-1V5z" />
            <path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z" />
          </svg>
        </Button>
      )}
      <Button
        onClick={handleSend}
        disabled={disabled || !text.trim()}
        size="icon"
        className="min-w-[44px] min-h-[44px]"
      >
        <svg viewBox="0 0 24 24" className="w-5 h-5" fill="currentColor">
          <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
        </svg>
      </Button>
    </div>
  );
}
