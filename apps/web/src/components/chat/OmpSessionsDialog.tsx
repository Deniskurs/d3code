import { useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { HistoryIcon, GitForkIcon, RefreshCwIcon, TerminalIcon, ArrowLeftIcon } from "lucide-react";
import {
  WS_METHODS,
  type EnvironmentId,
  type ProjectId,
  type ProviderInstanceId,
  type ThreadId,
  type OmpSessionsReadResult,
  type OmpSessionsActionInput,
} from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { connectionAtomRuntime } from "../../connection/runtime";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogFooter,
} from "../ui/dialog";

const readSessions = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "omp-sessions:read",
  tag: WS_METHODS.ompSessionsRead,
});
const actOnSession = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "omp-sessions:action",
  tag: WS_METHODS.ompSessionsAction,
});
type SavedSession = OmpSessionsReadResult["sessions"][number];
const failureMessage = (error: unknown) =>
  error instanceof Error ? error.message : "Could not complete the OMP session operation.";

export function OmpSessionsDialog({
  environmentId,
  projectId,
  instanceId,
  currentThreadId,
  scopeThreadId,
  onRunTerminal,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  instanceId: ProviderInstanceId;
  currentThreadId: string;
  scopeThreadId?: ThreadId | undefined;
  onRunTerminal?: ((command: string) => void) | undefined;
}) {
  const [open, setOpen] = useState(false);
  const [sessions, setSessions] = useState<ReadonlyArray<SavedSession>>([]);
  const [cursor, setCursor] = useState<string>();
  const [selected, setSelected] = useState<SavedSession>();
  const [preview, setPreview] = useState<OmpSessionsReadResult>();
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [resumeCommand, setResumeCommand] = useState<string>();
  const [supportsFork, setSupportsFork] = useState(false);
  const generation = useRef(0);
  const read = useAtomCommand(readSessions, { reportFailure: false });
  const act = useAtomCommand(actOnSession, { reportFailure: false });
  const navigate = useNavigate();

  const load = async (nextCursor?: string) => {
    const request = ++generation.current;
    setBusy(true);
    setError(undefined);
    const result = await read({
      environmentId,
      input: {
        instanceId,
        projectId,
        ...(scopeThreadId ? { threadId: scopeThreadId } : {}),
        ...(nextCursor ? { cursor: nextCursor } : {}),
      },
    });
    if (request !== generation.current) return;
    setBusy(false);
    if (result._tag === "Failure") {
      setError(failureMessage(squashAtomCommandFailure(result)));
      return;
    }
    setSessions((previous) =>
      nextCursor
        ? [
            ...previous,
            ...result.value.sessions.filter(
              (session) => !previous.some((entry) => entry.sessionId === session.sessionId),
            ),
          ]
        : result.value.sessions,
    );
    setCursor(result.value.nextCursor);
    setSupportsFork(result.value.supportsFork);
  };

  const select = async (session: SavedSession) => {
    const request = ++generation.current;
    setSelected(session);
    setPreview(undefined);
    setError(undefined);
    setNotice(undefined);
    setResumeCommand(undefined);
    // Attached sessions are previewed in their existing chat, without opening a second native writer.
    if (session.threadId) return;
    setBusy(true);
    const result = await read({
      environmentId,
      input: {
        instanceId,
        projectId,
        ...(scopeThreadId ? { threadId: scopeThreadId } : {}),
        sessionId: session.sessionId,
      },
    });
    if (request !== generation.current) return;
    setBusy(false);
    if (result._tag === "Failure") setError(failureMessage(squashAtomCommandFailure(result)));
    else setPreview(result.value);
  };

  const perform = async (action: OmpSessionsActionInput["action"]) => {
    if (!selected || busy) return;
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    const result = await act({
      environmentId,
      input: {
        instanceId,
        projectId,
        ...(scopeThreadId ? { threadId: scopeThreadId } : {}),
        sessionId: selected.sessionId,
        action,
      },
    });
    setBusy(false);
    if (result._tag === "Failure") {
      setError(failureMessage(squashAtomCommandFailure(result)));
      return;
    }
    if (action === "handoff") {
      setResumeCommand(result.value.resumeCommand);
      setNotice(
        "D3 has released this session. Run the command below on the environment's machine. Close OMP there before returning to D3, then refresh history.",
      );
      return;
    }
    if (action === "refresh") {
      setResumeCommand(undefined);
      setNotice(
        result.value.importedMessages
          ? `Added ${result.value.importedMessages} messages from OMP.`
          : "History is up to date.",
      );
      return;
    }
    setOpen(false);
    await navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId, threadId: result.value.threadId },
    });
  };

  const visibleSessions = sessions.filter((session) =>
    `${session.title ?? ""} ${session.sessionId}`
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => {
          setOpen(true);
          setSelected(undefined);
          setQuery("");
          setNotice(undefined);
          setResumeCommand(undefined);
          void load();
        }}
        aria-label="Browse OMP sessions"
      >
        <HistoryIcon className="size-4" />
        <span className="hidden lg:inline">OMP sessions</span>
      </Button>
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!busy) {
            setOpen(value);
            generation.current++;
          }
        }}
      >
        <DialogPopup className="w-[min(48rem,calc(100vw-2rem))] max-w-3xl">
          <DialogHeader>
            <DialogTitle>{selected ? selected.title || "OMP session" : "OMP sessions"}</DialogTitle>
            <DialogDescription>
              {selected
                ? "Continue the same conversation in D3 or OMP's terminal."
                : "Saved conversations for this project and OMP provider instance."}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-4">
            {error && (
              <p
                role="alert"
                className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
              >
                {error}
              </p>
            )}
            {notice && (
              <p role="status" className="rounded-lg border bg-muted/40 p-3 text-sm">
                {notice}
              </p>
            )}
            {selected ? (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    generation.current++;
                    setSelected(undefined);
                    setError(undefined);
                    setNotice(undefined);
                    setResumeCommand(undefined);
                    void load();
                  }}
                >
                  <ArrowLeftIcon className="size-4" />
                  All sessions
                </Button>
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-xs">
                  <dt className="text-muted-foreground">Session</dt>
                  <dd className="break-all font-mono select-text">{selected.sessionId}</dd>
                  <dt className="text-muted-foreground">Project</dt>
                  <dd className="break-all select-text">{selected.cwd}</dd>
                  <dt className="text-muted-foreground">Provider</dt>
                  <dd>{instanceId}</dd>
                </dl>
                <p className="text-xs text-muted-foreground">
                  Close this session in OMP's terminal before opening, refreshing, or forking it
                  here. For terminal-only commands such as /tree or /login, use Continue in
                  terminal.
                </p>
                {resumeCommand && (
                  <div className="space-y-2">
                    <pre className="whitespace-pre-wrap break-all rounded-lg border bg-muted/40 p-3 text-xs select-text">
                      {resumeCommand}
                    </pre>
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          void navigator.clipboard.writeText(resumeCommand).then(
                            () => setNotice("Resume command copied."),
                            () => setError("Could not copy. Select and copy the command above."),
                          );
                        }}
                      >
                        Copy resume command
                      </Button>
                      {onRunTerminal && selected.threadId === currentThreadId && (
                        <Button
                          size="sm"
                          onClick={() => {
                            setOpen(false);
                            onRunTerminal(resumeCommand);
                          }}
                        >
                          <TerminalIcon className="size-4" />
                          Open in D3 terminal
                        </Button>
                      )}
                    </div>
                  </div>
                )}
                {preview && (
                  <div
                    className="max-h-80 space-y-4 overflow-y-auto rounded-lg border p-4"
                    aria-label="Native session history"
                  >
                    {preview.messages.length === 0 ? (
                      <p className="text-sm text-muted-foreground">
                        This session has no text messages yet.
                      </p>
                    ) : (
                      preview.messages.map((message) => (
                        <div
                          key={
                            message.nativeId ??
                            `${message.role}:${message.createdAt}:${message.text}`
                          }
                          className="space-y-1"
                        >
                          <p className="text-xs font-medium text-muted-foreground">
                            {message.role === "user" ? "You" : "OMP"}
                          </p>
                          <p className="whitespace-pre-wrap break-words text-sm select-text">
                            {message.text}
                          </p>
                        </div>
                      ))
                    )}
                  </div>
                )}
              </>
            ) : (
              <>
                <div className="flex gap-2">
                  <Input
                    aria-label="Search OMP sessions"
                    placeholder="Search titles or session IDs..."
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                  />
                  <Button
                    variant="outline"
                    size="icon"
                    disabled={busy}
                    aria-label="Refresh session list"
                    onClick={() => void load()}
                  >
                    <RefreshCwIcon className="size-4" />
                  </Button>
                </div>
                <div className="max-h-96 space-y-1 overflow-y-auto" aria-label="Saved OMP sessions">
                  {visibleSessions.map((session) => (
                    <button
                      key={session.sessionId}
                      type="button"
                      disabled={busy}
                      className="flex w-full items-center gap-3 rounded-lg p-3 text-left hover:bg-accent focus-visible:outline focus-visible:outline-ring disabled:opacity-50"
                      onClick={() => void select(session)}
                    >
                      <HistoryIcon className="size-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">
                          {session.title || "Untitled OMP session"}
                        </span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {session.updatedAt
                            ? new Date(session.updatedAt).toLocaleString()
                            : session.sessionId}
                        </span>
                      </span>
                      {session.threadId && (
                        <span className="shrink-0 rounded border px-2 py-0.5 text-xs text-muted-foreground">
                          In D3
                        </span>
                      )}
                    </button>
                  ))}
                  {!busy && visibleSessions.length === 0 && !error && (
                    <p className="py-10 text-center text-sm text-muted-foreground">
                      {sessions.length === 0
                        ? "No saved OMP sessions in this project and profile yet."
                        : "No matching sessions. Try another search or load more sessions."}
                    </p>
                  )}
                </div>
                {cursor && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => void load(cursor)}
                  >
                    Load more sessions
                  </Button>
                )}
              </>
            )}
            {busy && (
              <p role="status" className="text-sm text-muted-foreground">
                Working with OMP...
              </p>
            )}
          </DialogPanel>
          {selected && (
            <DialogFooter className="flex-wrap">
              {selected.threadId && (
                <>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => void perform("handoff")}
                  >
                    <TerminalIcon className="size-4" />
                    Continue in terminal
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => void perform("refresh")}
                  >
                    <RefreshCwIcon className="size-4" />
                    Refresh history
                  </Button>
                </>
              )}
              {supportsFork && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => void perform("fork")}
                >
                  <GitForkIcon className="size-4" />
                  Fork session
                </Button>
              )}
              <Button size="sm" disabled={busy} onClick={() => void perform("open")}>
                {selected.threadId ? "Open chat" : "Continue in D3"}
              </Button>
            </DialogFooter>
          )}
        </DialogPopup>
      </Dialog>
    </>
  );
}
