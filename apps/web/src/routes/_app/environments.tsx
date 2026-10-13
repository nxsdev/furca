import { Button, Description, Drawer, Dropdown, FieldError, Input, Label, Spinner, TextField, toast, Tooltip } from "@heroui/react";
import type { EnvironmentListItem } from "@furca/api/contract";
import type { Environment } from "@furca/core/environments/Environment";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { FileJson, KeyRound, MoreHorizontal, Plus, RotateCw, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { CodeBlock, Quickstart } from "~/components/environments/Quickstart";
import { formatBytes, TrafficSparkline } from "~/components/environments/Sparkline";
import { slugify } from "~/components/metrics/MetricForm";
import { environmentHue } from "~/components/shell/Sidebar";
import { ConfirmDialog } from "~/components/ui/ConfirmDialog";
import { CopyButton, EmptyState, ListSkeleton, PageHeader, Panel, QueryError } from "~/components/ui/primitives";
import { tbl } from "~/components/ui/table";
import { errorMessage, orpc } from "~/lib/rpc";

export const Route = createFileRoute("/_app/environments")({
  head: () => ({ meta: [{ title: "SDK & environments · furca" }] }),
  component: Page,
});

const LARGE_PAYLOAD = 100 * 1024;

function PayloadSize({ bytes }: { bytes: number | null }) {
  if (bytes === null) return <span className="text-muted">Not published</span>;
  if (bytes <= LARGE_PAYLOAD) return <span className="font-mono tabular">{formatBytes(bytes)}</span>;
  return (
    <Tooltip delay={200}>
      <Tooltip.Trigger className="inline-flex items-center gap-1.5 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-focus">
        <TriangleAlert className="size-3.5 text-health" aria-hidden="true" />
        <span className="font-mono tabular">{formatBytes(bytes)}</span>
        <span className="text-meta text-muted">Large</span>
      </Tooltip.Trigger>
      <Tooltip.Content className="max-w-64">
        Above 100 KB, SDK startup gets slower on mobile networks. Archive unused flags or move large JSON values out of flags.
      </Tooltip.Content>
    </Tooltip>
  );
}

function CreateEnvironment({ onDone }: { onDone: () => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  const [keyEdited, setKeyEdited] = useState(false);
  const create = useMutation(
    orpc.environments.create.mutationOptions({
      onSuccess: (env) => {
        void queryClient.invalidateQueries({ queryKey: orpc.environments.key() });
        void queryClient.invalidateQueries({ queryKey: orpc.audit.key() });
        toast.success(`${env.name} created`, { description: "Flags start disabled here. Copy its SDK key below." });
        onDone();
      },
    }),
  );
  const keyValid = /^[a-z0-9][a-z0-9_-]{0,63}$/.test(key);
  return (
    <form
      className="flex flex-col gap-4 border-b border-border bg-default/30 px-5 py-4 sm:flex-row sm:items-start"
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim() !== "" && keyValid) create.mutate({ name: name.trim(), key });
      }}
    >
      <TextField
        value={name}
        onChange={(v) => {
          setName(v);
          if (!keyEdited) setKey(slugify(v));
        }}
        isRequired
        autoFocus
        className="sm:w-56"
      >
        <Label>Name</Label>
        <Input placeholder="Staging" />
      </TextField>
      <TextField
        value={key}
        onChange={(v) => {
          setKey(v);
          setKeyEdited(true);
        }}
        isRequired
        isInvalid={key !== "" && !keyValid}
        className="sm:w-56"
      >
        <Label>Key</Label>
        <Input placeholder="staging" spellCheck={false} className="font-mono" />
        <Description>Can't be changed later.</Description>
        <FieldError>Use lowercase letters, digits, - and _</FieldError>
      </TextField>
      <div className="flex items-center gap-2 sm:mt-6">
        <Button type="submit" size="sm" isPending={create.isPending} isDisabled={name.trim() === "" || !keyValid}>
          Create
        </Button>
        <Button size="sm" variant="tertiary" onPress={onDone}>
          Cancel
        </Button>
      </div>
      {create.error !== null && (
        <p role="alert" className="text-label text-danger sm:mt-7">
          {errorMessage(create.error)}
        </p>
      )}
    </form>
  );
}

function PayloadDrawer({ env, onClose }: { env: Environment | null; onClose: () => void }) {
  const payload = useQuery({
    ...orpc.environments.payload.queryOptions({ input: { id: env?.id ?? "" } }),
    enabled: env !== null,
  });
  return (
    <Drawer.Backdrop isOpen={env !== null} onOpenChange={(open) => !open && onClose()}>
      <Drawer.Content placement="right">
        <Drawer.Dialog className="w-[min(680px,100vw)] max-w-full gap-0 p-0 sm:w-[680px]">
          <Drawer.CloseTrigger />
          <Drawer.Header className="flex flex-col gap-1 border-b border-border px-5 py-4">
            <Drawer.Heading className="text-section font-semibold">Payload · {env?.name}</Drawer.Heading>
            <p className="text-label text-muted">
              The exact JSON SDKs download from <code className="font-mono">/api/sdk/v1/payload/{"<sdk key>"}</code>.
              Disabled flags are left out.
            </p>
          </Drawer.Header>
          <Drawer.Body className="min-h-0 flex-1 overflow-auto p-5">
            {payload.isPending ? (
              <div className="flex justify-center py-10">
                <Spinner size="sm" color="current" />
              </div>
            ) : payload.isError ? (
              <QueryError message={`Couldn't load the payload. ${errorMessage(payload.error)}`} onRetry={() => payload.refetch()} />
            ) : (
              <>
                <p className="mb-2 text-meta text-muted tabular">{formatBytes(new TextEncoder().encode(payload.data).length)}</p>
                <CodeBlock code={payload.data} label="Copy JSON" className="" />
              </>
            )}
          </Drawer.Body>
        </Drawer.Dialog>
      </Drawer.Content>
    </Drawer.Backdrop>
  );
}

function EnvironmentRow({
  item,
  onPayload,
  onRotate,
}: {
  item: EnvironmentListItem;
  onPayload: () => void;
  onRotate: () => void;
}) {
  const env = item.environment;
  return (
    <tr className={tbl.tr}>
      <td className={tbl.td}>
        <span className="flex items-center gap-2.5">
          <span className={`size-2 shrink-0 rounded-full ${environmentHue(env.key)}`} aria-hidden="true" />
          <span className="min-w-0">
            <span className="block truncate font-medium">{env.name}</span>
            <code className="block truncate font-mono text-meta text-muted">{env.key}</code>
            <span className="relative z-1 flex items-center gap-1 sm:hidden">
              <code className="max-w-[140px] truncate font-mono text-meta">{env.sdkKey}</code>
              <CopyButton value={env.sdkKey} label="Copy SDK key" />
            </span>
          </span>
        </span>
      </td>
      <td className={`${tbl.td} hidden sm:table-cell`}>
        <span className="flex items-center gap-1">
          <code className="max-w-[220px] truncate font-mono">{env.sdkKey}</code>
          <CopyButton value={env.sdkKey} label="Copy SDK key" />
        </span>
      </td>
      <td className={`${tbl.td} hidden whitespace-nowrap sm:table-cell`}>
        <PayloadSize bytes={item.payloadBytes} />
      </td>
      <td className={`${tbl.td} hidden text-right font-mono tabular md:table-cell`}>{item.featureCount}</td>
      <td className={`${tbl.td} hidden lg:table-cell`}>
        <TrafficSparkline environmentId={env.id} />
      </td>
      <td className={`${tbl.td} w-px whitespace-nowrap text-right`}>
        <span className="inline-flex items-center gap-1">
          <Button size="sm" variant="ghost" onPress={onPayload} className="h-8">
            <FileJson className="size-4" />
            <span className="hidden sm:inline">Payload</span>
          </Button>
          <Dropdown>
            <Button isIconOnly size="sm" variant="ghost" aria-label={`More actions for ${env.name}`} className="size-8 min-w-8">
              <MoreHorizontal className="size-4" />
            </Button>
            <Dropdown.Popover placement="bottom end" className="min-w-48">
              <Dropdown.Menu onAction={(k) => k === "rotate" && onRotate()}>
                <Dropdown.Item id="rotate" textValue="Rotate SDK key" variant="danger">
                  <RotateCw className="size-4" />
                  <Label>Rotate SDK key…</Label>
                </Dropdown.Item>
              </Dropdown.Menu>
            </Dropdown.Popover>
          </Dropdown>
        </span>
      </td>
    </tr>
  );
}

function Page() {
  const queryClient = useQueryClient();
  const list = useQuery(orpc.environments.list.queryOptions());
  const [creating, setCreating] = useState(false);
  const [payloadEnv, setPayloadEnv] = useState<Environment | null>(null);
  // Target outlives `rotateOpen` so the dialog keeps its text during the exit animation
  const [rotating, setRotating] = useState<Environment | null>(null);
  const [rotateOpen, setRotateOpen] = useState(false);
  const rotate = useMutation(
    orpc.environments.rotateSdkKey.mutationOptions({
      onSuccess: (env) => {
        void queryClient.invalidateQueries({ queryKey: orpc.environments.key() });
        void queryClient.invalidateQueries({ queryKey: orpc.audit.key() });
        setRotateOpen(false);
        toast.success(`New SDK key for ${env.name}`, { description: "Deploy it to every app that uses this environment." });
      },
    }),
  );

  return (
    <>
      <PageHeader
        title="SDK & environments"
        description="Each environment has its own SDK key, flag states and payload. SDKs download the payload once and evaluate flags locally."
        actions={
          <Button size="sm" onPress={() => setCreating(true)} isDisabled={creating}>
            <Plus className="size-4" />
            New environment
          </Button>
        }
      />
      <div className="flex flex-col gap-6">
        {list.isPending ? (
          <Panel>
            <ListSkeleton rows={3} />
          </Panel>
        ) : list.isError ? (
          <QueryError message={`Couldn't load environments. ${errorMessage(list.error)}`} onRetry={() => list.refetch()} />
        ) : list.data.length === 0 && !creating ? (
          <EmptyState
            icon={<KeyRound />}
            title="No environments"
            description="Create one to get an SDK key. Most teams start with production and development."
            action={
              <Button size="sm" onPress={() => setCreating(true)}>
                New environment
              </Button>
            }
          />
        ) : (
          <Panel>
            {creating && <CreateEnvironment onDone={() => setCreating(false)} />}
            <div className="overflow-x-auto">
              <table className={tbl.table}>
                <thead>
                  <tr>
                    <th className={tbl.th}>Environment</th>
                    <th className={`${tbl.th} hidden sm:table-cell`}>SDK key</th>
                    <th className={`${tbl.th} hidden sm:table-cell`}>Payload</th>
                    <th className={`${tbl.th} hidden text-right md:table-cell`}>Flags on</th>
                    <th className={`${tbl.th} hidden lg:table-cell`}>Last 24h</th>
                    <th className={tbl.th}>
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {list.data.map((item) => (
                    <EnvironmentRow
                      key={item.environment.id}
                      item={item}
                      onPayload={() => setPayloadEnv(item.environment)}
                      onRotate={() => {
                        setRotating(item.environment);
                        rotate.reset();
                        setRotateOpen(true);
                      }}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        )}
        <Quickstart />
      </div>

      <PayloadDrawer env={payloadEnv} onClose={() => setPayloadEnv(null)} />
      <ConfirmDialog
        isOpen={rotateOpen}
        onOpenChange={setRotateOpen}
        title={`Rotate the ${rotating?.name ?? ""} SDK key?`}
        confirmLabel="Rotate key"
        isPending={rotate.isPending}
        error={rotate.error === null ? null : errorMessage(rotate.error)}
        onConfirm={() => rotating !== null && rotate.mutate({ id: rotating.id })}
      >
        <p>
          A new key is issued immediately. Apps still using{" "}
          <code className="break-all font-mono text-foreground">{rotating?.sdkKey}</code> get your fallback value for every flag,
          and their exposures and events are dropped until you deploy the new key.
        </p>
      </ConfirmDialog>
    </>
  );
}
