import { AlertDialog, Button } from "@heroui/react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

/**
 * Destructive confirmation. Stays open while the action runs and shows the server's message
 * inline (e.g. a CONFLICT explaining why it cannot be done), so the user never loses context
 */
export function ConfirmDialog({
  isOpen,
  onOpenChange,
  title,
  children,
  confirmLabel,
  onConfirm,
  isPending = false,
  error = null,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  isPending?: boolean;
  error?: string | null;
}) {
  const { t } = useTranslation();
  return (
    <AlertDialog.Backdrop isOpen={isOpen} onOpenChange={onOpenChange}>
      <AlertDialog.Container size="sm">
        <AlertDialog.Dialog>
          <AlertDialog.Header>
            <AlertDialog.Icon status="danger" />
            <AlertDialog.Heading className="text-section font-semibold">{title}</AlertDialog.Heading>
          </AlertDialog.Header>
          <AlertDialog.Body className="flex flex-col gap-3 text-body text-muted">
            {children}
            {error !== null && (
              <p role="alert" className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-label text-danger">
                {error}
              </p>
            )}
          </AlertDialog.Body>
          <AlertDialog.Footer>
            <Button slot="close" variant="tertiary" size="sm" isDisabled={isPending}>
              {t(($) => $.actions.cancel)}
            </Button>
            <Button variant="danger" size="sm" isPending={isPending} onPress={onConfirm}>
              {confirmLabel}
            </Button>
          </AlertDialog.Footer>
        </AlertDialog.Dialog>
      </AlertDialog.Container>
    </AlertDialog.Backdrop>
  );
}
