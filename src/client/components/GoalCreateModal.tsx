import { useState, useEffect } from 'react';
import { Drawer } from 'vaul';
import * as Select from '@radix-ui/react-select';
import type { WSClientMessage, Goal } from '../lib/types';
import { useStore } from '../stores/store';

interface Props {
  onSend: (msg: WSClientMessage) => void;
  onClose: () => void;
  editGoal?: Goal | null;
}

function RadixSelect({ value, onValueChange, placeholder, items }: {
  value: string;
  onValueChange: (v: string) => void;
  placeholder: string;
  items: { value: string; label: string }[];
}) {
  return (
    <Select.Root value={value} onValueChange={onValueChange}>
      <Select.Trigger className="w-full flex items-center justify-between bg-[#0a0a0f] border border-[#1e1e2e] rounded-lg px-3 py-2 text-sm text-[#e2e2ef] focus:outline-none focus:border-[#7c5bf5]">
        <Select.Value placeholder={placeholder} />
        <Select.Icon className="text-[#6b6b80]">▾</Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content className="radix-select-content z-[60]" position="popper" sideOffset={4}>
          <Select.Viewport>
            <Select.Item value="" className="radix-select-item">
              <Select.ItemText>{placeholder}</Select.ItemText>
            </Select.Item>
            {items.map((item) => (
              <Select.Item key={item.value} value={item.value} className="radix-select-item">
                <Select.ItemText>{item.label}</Select.ItemText>
              </Select.Item>
            ))}
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}

export function GoalCreateModal({ onSend, onClose, editGoal }: Props) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [repoId, setRepoId] = useState('');
  const repos = useStore((s) => s.repos);

  const isEdit = !!editGoal;

  useEffect(() => {
    if (editGoal) {
      setName(editGoal.name);
      setDescription(editGoal.description || '');
      setRepoId(editGoal.repo_id || '');
    } else {
      setName('');
      setDescription('');
      setRepoId('');
    }
  }, [editGoal]);

  const handleCreate = () => {
    if (!name.trim()) return;
    onSend({ 
      type: 'goal:create', 
      name: name.trim(), 
      description: description.trim(),
      repoId: repoId || undefined
    });
    onClose();
  };

  const handleUpdate = () => {
    if (!name.trim() || !editGoal) return;
    onSend({
      type: 'goal:update',
      goalId: editGoal.id,
      fields: {
        name: name.trim(),
        description: description.trim(),
        repo_id: repoId || null,
      },
    });
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
            <Drawer.Title className="text-lg font-bold text-[#e2e2ef]">
              {isEdit ? 'Edit Goal' : 'New Goal'}
            </Drawer.Title>
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

          <label className="text-xs text-[#6b6b80] mb-1 block">Repo (optional)</label>
          <div className="mb-4">
            <RadixSelect
              value={repoId}
              onValueChange={setRepoId}
              placeholder="No repo assigned"
              items={repos.map((repo) => ({
                value: repo.path,
                label: repo.name,
              }))}
            />
          </div>

          <button
            onClick={isEdit ? handleUpdate : handleCreate}
            disabled={!name.trim()}
            className="w-full bg-[#7c5bf5] text-white py-2.5 rounded-lg text-sm font-medium active:bg-[#6b4ae4] transition-colors disabled:opacity-40"
          >
            {isEdit ? 'Save Changes' : 'Create Goal'}
          </button>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}
