import { Drawer } from 'vaul';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from './ui/dialog';
import { Button } from './ui/button';
import { useIsDesktop } from '../hooks/useIsDesktop';

interface Props {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  snapPoints?: (number | string)[];
}

export function DrawerModal({ open, onClose, title, children, snapPoints }: Props) {
  const isDesktop = useIsDesktop();

  if (isDesktop) {
    return (
      <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
          </DialogHeader>
          {children}
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Drawer.Root open={open} onOpenChange={(o) => !o && onClose()} snapPoints={snapPoints}>
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" />
        <Drawer.Content className="fixed bottom-0 left-0 right-0 z-50 rounded-t-2xl outline-none bg-card border-t border-border">
          <div className="pt-3 pb-2">
            <div className="mx-auto h-1 w-10 rounded-full bg-muted-foreground/40" />
          </div>
          <div className="overflow-y-auto max-h-[calc(95dvh-2rem)] px-4 pb-8">
            <div className="flex items-center justify-between mb-4">
              <Drawer.Title className="text-lg font-bold text-foreground">{title}</Drawer.Title>
              <Button variant="ghost" size="sm" onClick={onClose} className="text-muted-foreground">
                x
              </Button>
            </div>
            {children}
          </div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}
