import { Drawer } from 'vaul';

interface Props {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  snapPoints?: (number | string)[];
}

export function DrawerModal({ open, onClose, title, children, snapPoints }: Props) {
  return (
    <Drawer.Root open={open} onOpenChange={(o) => !o && onClose()} snapPoints={snapPoints}>
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 z-50 bg-black/60" />
        <Drawer.Content className="fixed bottom-0 left-0 right-0 z-50 rounded-t-2xl outline-none bg-[#1e1e2e]">
          <div className="pt-3 pb-2">
            <div className="mx-auto h-1 w-10 rounded-full bg-[#6b6b80]/40" />
          </div>
          <div className="overflow-y-auto max-h-[calc(95dvh-2rem)] px-4 pb-8">
            <div className="flex items-center justify-between mb-4">
              <Drawer.Title className="text-lg font-bold text-[#e2e2ef]">{title}</Drawer.Title>
              <button onClick={onClose} className="text-[#6b6b80] text-xl px-2">x</button>
            </div>
            {children}
          </div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}
