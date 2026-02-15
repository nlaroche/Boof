import { useState } from 'react';
import { Drawer } from 'vaul';
import type { WSClientMessage } from '../lib/types';

interface Props {
  onSend: (msg: WSClientMessage) => void;
  onClose: () => void;
}

export function GoalCreateModal({ onSend, onClose }: Props) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');

  const handleCreate = () => {
    if (!name.trim()) return;
    onSend({ type: 'goal:create', name: name.trim(), description: description.trim() });
    onClose();
  };

  return (
    <Drawer.Root open onOpenChange={(open) => !open && onClose()}>
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 z-50" />
        <Drawer.Content className="fixed bottom-0 left-0 right-0 z-50 rounded-t-2xl p-4 pb-8 outline-none">
          {/* Drag handle */}
          <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-[#6b6b80]/40" />

          <div className="flex items-center justify-between mb-4">
            <Drawer.Title className="text-lg font-bold text-[#e2e2ef]">New Goal</Drawer.Title>
            <button onClick={onClose} className="text-[#6b6b80] text-xl px-2">x</button>
          </div>

          <label className="text-xs text-[#6b6b80] mb-1 block">Name</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Improve Boof UI polish"
            autoFocus
            className="w-full bg-[#0a0a0f] border border-[#1e1e2e] rounded-lg px-3 py-2 mb-4 text-sm text-[#e2e2ef] placeholder-[#6b6b80] focus:outline-none focus:border-[#7c5bf5]"
          />

          <label className="text-xs text-[#6b6b80] mb-1 block">Description</label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What should the agent work towards?"
            rows={3}
            className="w-full bg-[#0a0a0f] border border-[#1e1e2e] rounded-lg px-3 py-2 mb-4 text-sm text-[#e2e2ef] placeholder-[#6b6b80] focus:outline-none focus:border-[#7c5bf5] resize-none"
          />

          <button
            onClick={handleCreate}
            disabled={!name.trim()}
            className="w-full bg-[#7c5bf5] text-white py-2.5 rounded-lg text-sm font-medium active:bg-[#6b4ae4] transition-colors disabled:opacity-40"
          >
            Create Goal
          </button>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}
