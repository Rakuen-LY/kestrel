import { useCallback, useEffect, useMemo, useState } from "react";
import type { WorkspaceEntry, WorkspaceFile, WorkspaceListing } from "@kestrel/protocol";
import type { KestrelApi } from "../api";
import { matchesFile, type LoadedExtension } from "../extensions";
import { PluginSlot } from "./PluginSlot";
import { ChevronIcon, CloseIcon, FilesIcon } from "./icons";

interface Props {
  open: boolean;
  api: KestrelApi;
  sessionId?: string;
  extensions: LoadedExtension[];
  onClose: () => void;
}

const MAX_RENDERED_LINES = 5_000;

const formatSize = (bytes: number | undefined): string => {
  if (bytes === undefined) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

/**
 * Read-only workspace browser. It talks to the server-side file API, which
 * keeps every path inside the session workspace, and hands the current file to
 * plugins that registered a `file.viewer` contribution for its extension.
 */
export function FileViewer({ open, api, sessionId, extensions, onClose }: Props) {
  const [directory, setDirectory] = useState(".");
  const [listing, setListing] = useState<WorkspaceListing>();
  const [listError, setListError] = useState<string>();
  const [filePath, setFilePath] = useState<string>();
  const [file, setFile] = useState<WorkspaceFile>();
  const [fileError, setFileError] = useState<string>();
  const [tab, setTab] = useState<"preview" | "source">("preview");
  const [loadingList, setLoadingList] = useState(false);
  const [loadingFile, setLoadingFile] = useState(false);

  const pluginPreview = useMemo(
    () =>
      file
        ? extensions
            .filter((extension) => extension.slot === "file.viewer" && matchesFile(extension.match, file))
            .sort((a, b) => (a.order ?? 100) - (b.order ?? 100))
        : [],
    [extensions, file],
  );

  useEffect(() => {
    setDirectory(".");
    setFilePath(undefined);
    setFile(undefined);
  }, [sessionId]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (!open || !sessionId) return;
    let cancelled = false;
    setLoadingList(true);
    setListError(undefined);
    api
      .listFiles(sessionId, directory)
      .then((result) => {
        if (!cancelled) setListing(result);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setListError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!cancelled) setLoadingList(false);
      });
    return () => {
      cancelled = true;
    };
  }, [api, open, sessionId, directory]);

  useEffect(() => {
    if (!open || !sessionId || !filePath) {
      setFile(undefined);
      return;
    }
    let cancelled = false;
    setLoadingFile(true);
    setFileError(undefined);
    setTab("preview");
    api
      .readFile(sessionId, filePath)
      .then((result) => {
        if (!cancelled) setFile(result);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setFileError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!cancelled) setLoadingFile(false);
      });
    return () => {
      cancelled = true;
    };
  }, [api, open, sessionId, filePath]);

  const navigate = useCallback((path: string) => {
    setDirectory(path);
    setFilePath(undefined);
    setFile(undefined);
  }, []);

  const openEntry = useCallback(
    (entry: WorkspaceEntry) => {
      if (entry.type === "directory") navigate(entry.path);
      else {
        setFilePath(entry.path);
        setFile(undefined);
      }
    },
    [navigate],
  );

  if (!open) return null;

  const segments: Array<{ label: string; path: string }> = [];
  if (directory !== ".") {
    const parts = directory.split("/");
    parts.forEach((part, index) => {
      segments.push({ label: part, path: parts.slice(0, index + 1).join("/") });
    });
  }

  const parent = directory === "." ? undefined : directory.split("/").slice(0, -1).join("/") || ".";

  return (
    <div className="drawer-backdrop" onClick={onClose} role="presentation">
      <aside
        className="drawer file-viewer"
        onClick={(event) => event.stopPropagation()}
        aria-label="Workspace files"
      >
        <header className="drawer-head">
          <div>
            <h2>Files</h2>
            <p>Read-only view of the session workspace</p>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close files">
            <CloseIcon size={18} />
          </button>
        </header>

        <div className="file-breadcrumb">
          <button type="button" className="file-crumb" onClick={() => navigate(".")}>
            workspace
          </button>
          {segments.map((segment) => (
            <span key={segment.path} className="file-crumb-group">
              <ChevronIcon size={12} />
              <button type="button" className="file-crumb" onClick={() => navigate(segment.path)}>
                {segment.label}
              </button>
            </span>
          ))}
        </div>

        <div className="file-body">
          <div className="file-tree">
            {listError && <p className="settings-note error">{listError}</p>}
            {loadingList && !listing && <p className="settings-note">Loading…</p>}
            {parent && (
              <button type="button" className="file-row" onClick={() => openEntry({ name: "..", path: parent, type: "directory" })}>
                <span className="file-icon">↩</span>
                <span className="file-name">..</span>
              </button>
            )}
            {listing?.entries.map((entry) => (
              <button
                key={entry.path}
                type="button"
                className={`file-row${entry.path === filePath ? " selected" : ""}`}
                onClick={() => openEntry(entry)}
                title={entry.path}
              >
                <span className="file-icon">{entry.type === "directory" ? <FilesIcon size={14} /> : "·"}</span>
                <span className="file-name">{entry.name}</span>
                {entry.type === "file" && <span className="file-size">{formatSize(entry.size)}</span>}
              </button>
            ))}
            {listing && listing.entries.length === 0 && <p className="settings-note">This folder is empty.</p>}
            {listing?.truncated && <p className="settings-note">Listing truncated at 500 entries.</p>}
          </div>

          <div className="file-preview">
            {!filePath && <p className="settings-note">Select a file to preview it.</p>}
            {fileError && <p className="settings-note error">{fileError}</p>}
            {loadingFile && !file && <p className="settings-note">Loading…</p>}
            {file && (
              <>
                <div className="file-preview-head">
                  <div className="file-preview-title">
                    <strong>{file.name}</strong>
                    <span className="muted">
                      {formatSize(file.size)} · {file.mimeType}
                    </span>
                  </div>
                  {pluginPreview.length > 0 && (
                    <div className="file-tabs" role="tablist" aria-label="Preview mode">
                      <button
                        type="button"
                        role="tab"
                        aria-selected={tab === "preview"}
                        className={`file-tab${tab === "preview" ? " active" : ""}`}
                        onClick={() => setTab("preview")}
                      >
                        Preview
                      </button>
                      <button
                        type="button"
                        role="tab"
                        aria-selected={tab === "source"}
                        className={`file-tab${tab === "source" ? " active" : ""}`}
                        onClick={() => setTab("source")}
                      >
                        Source
                      </button>
                    </div>
                  )}
                </div>

                {pluginPreview.length > 0 && tab === "preview" ? (
                  <div className="file-plugin">
                    <PluginSlot
                      slot="file.viewer"
                      extensions={pluginPreview}
                      api={api}
                      sessionId={sessionId}
                      file={file}
                    />
                  </div>
                ) : (
                  <FileContent file={file} />
                )}
              </>
            )}
          </div>
        </div>
      </aside>
    </div>
  );
}

function FileContent({ file }: { file: WorkspaceFile }) {
  if (file.mimeType.startsWith("image/")) {
    return (
      <div className="file-image-wrap">
        <img
          className="file-image"
          src={`data:${file.mimeType};base64,${file.content}`}
          alt={`Preview of ${file.name}`}
        />
      </div>
    );
  }
  if (file.binary) {
    return (
      <p className="settings-note">
        Binary file ({file.mimeType}). {formatSize(file.size)} — preview it with a plugin or a tool call.
      </p>
    );
  }

  const lines = file.content.split("\n");
  const clipped = lines.length > MAX_RENDERED_LINES;
  const visible = clipped ? lines.slice(0, MAX_RENDERED_LINES) : lines;
  return (
    <>
      <pre className="file-text">
        {visible.map((line, index) => (
          <span key={index} className="file-line">
            <span className="file-line-no">{index + 1}</span>
            <span className="file-line-text">{line || " "}</span>
          </span>
        ))}
      </pre>
      {(clipped || file.truncated) && (
        <p className="settings-note">
          {clipped
            ? `Showing the first ${MAX_RENDERED_LINES} of ${lines.length} lines.`
            : "The preview is truncated at the server's read limit."}
        </p>
      )}
    </>
  );
}
