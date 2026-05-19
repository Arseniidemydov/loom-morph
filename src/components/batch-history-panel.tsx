'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { LeadStatus } from '@/types';

interface BatchListEntry {
  batchId: string;
  name?: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  total: number;
  done: number;
  failed: number;
  createdAt: number;
  finishedAt?: number;
  reportUrl: string;
  archiveUrl: string;
  eventsUrl: string;
}

interface BatchListResponse {
  batches: BatchListEntry[];
  error?: string;
}

interface LeadPreview {
  id: string;
  rowIndex: number;
  website: string;
  company: string;
  status: LeadStatus;
  progress: number;
  outputPath?: string;
  error?: string;
}

interface BatchSnapshotResponse {
  batchId: string;
  name?: string;
  status: BatchListEntry['status'];
  total: number;
  reportUrl: string;
  archiveUrl: string;
  eventsUrl: string;
  leads: LeadPreview[];
  error?: string;
}

interface BatchHistoryPanelProps {
  // Notifies the parent when a batch is opened so it can hydrate its own
  // workbench state (lead list, preview links, etc.). Optional — the panel
  // is useful as read-only history even without a click handler.
  onOpen?: (batchId: string) => void;
  // External version key — bumping it triggers a refresh. Lets the workbench
  // refresh after a new batch is started without us having to listen to SSE
  // here.
  refreshKey?: number;
  onDelete?: (batchId: string) => void;
  onVideoDelete?: (batchId: string, leadId: string, lead: LeadPreview) => void;
}

export function BatchHistoryPanel({
  onOpen,
  onDelete,
  onVideoDelete,
  refreshKey,
}: BatchHistoryPanelProps) {
  const [batches, setBatches] = useState<BatchListEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState('');
  const [openBatchId, setOpenBatchId] = useState('');
  const [details, setDetails] = useState<BatchSnapshotResponse | null>(null);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [detailsError, setDetailsError] = useState('');
  const [selectedLeadId, setSelectedLeadId] = useState('');
  const [deletingBatchId, setDeletingBatchId] = useState('');
  const [deletingVideoIds, setDeletingVideoIds] = useState<Set<string>>(() => new Set());

  const renderedLeads = useMemo(
    () => details?.leads.filter((lead) => lead.status === 'done' && lead.outputPath) ?? [],
    [details],
  );
  const selectedLead = useMemo(
    () =>
      renderedLeads.find((lead) => lead.id === selectedLeadId) ??
      renderedLeads[0] ??
      null,
    [renderedLeads, selectedLeadId],
  );
  const selectedVideoUrl =
    openBatchId && selectedLead
      ? `/api/batches/${encodeURIComponent(openBatchId)}/videos/${encodeURIComponent(
          selectedLead.id,
        )}`
      : '';

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await fetch('/api/batches', { cache: 'no-store' });
      const body = await readJsonResponse<BatchListResponse>(response);
      if (!response.ok) {
        throw new Error(body.error ?? `Could not load history (HTTP ${response.status})`);
      }
      setBatches(body.batches ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh, refreshKey]);

  useEffect(() => {
    if (renderedLeads.length === 0) {
      if (selectedLeadId) setSelectedLeadId('');
      return;
    }
    if (!renderedLeads.some((lead) => lead.id === selectedLeadId)) {
      setSelectedLeadId(renderedLeads[0]!.id);
    }
  }, [renderedLeads, selectedLeadId]);

  function beginRename(entry: BatchListEntry) {
    setEditingId(entry.batchId);
    setEditingValue(entry.name ?? '');
  }

  function cancelRename() {
    setEditingId(null);
    setEditingValue('');
  }

  async function commitRename(entry: BatchListEntry) {
    const next = editingValue.trim();
    if (next.length === 0 || next === (entry.name ?? '')) {
      cancelRename();
      return;
    }
    // Optimistic update — if the request fails we revert from the server.
    setBatches((prev) =>
      prev.map((b) => (b.batchId === entry.batchId ? { ...b, name: next } : b)),
    );
    setEditingId(null);
    try {
      const response = await fetch(`/api/batches/${encodeURIComponent(entry.batchId)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: next }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Rename failed (HTTP ${response.status})`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      refresh();
    }
  }

  async function openBatch(entry: BatchListEntry) {
    setOpenBatchId(entry.batchId);
    setDetails(null);
    setDetailsError('');
    setDetailsLoading(true);
    onOpen?.(entry.batchId);
    try {
      const response = await fetch(`/api/batches/${encodeURIComponent(entry.batchId)}`, {
        cache: 'no-store',
      });
      const body = await readJsonResponse<BatchSnapshotResponse>(response);
      if (!response.ok) {
        throw new Error(body.error ?? `Could not load batch (HTTP ${response.status})`);
      }
      setDetails(body);
      const firstOutput = body.leads.find((lead) => lead.status === 'done' && lead.outputPath);
      setSelectedLeadId(firstOutput?.id ?? '');
    } catch (err) {
      setDetailsError(err instanceof Error ? err.message : String(err));
    } finally {
      setDetailsLoading(false);
    }
  }

  async function deleteBatch(entry: BatchListEntry) {
    if (
      !window.confirm(
        `Delete ${entry.name || `Batch ${entry.batchId.slice(0, 8)}`} and all rendered videos?`,
      )
    ) {
      return;
    }
    setDeletingBatchId(entry.batchId);
    setError('');
    try {
      const response = await fetch(`/api/batches/${encodeURIComponent(entry.batchId)}`, {
        method: 'DELETE',
      });
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        throw new Error(body.error ?? `Delete failed (HTTP ${response.status})`);
      }
      setBatches((prev) => prev.filter((batch) => batch.batchId !== entry.batchId));
      if (openBatchId === entry.batchId) {
        setOpenBatchId('');
        setDetails(null);
        setSelectedLeadId('');
      }
      onDelete?.(entry.batchId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeletingBatchId('');
    }
  }

  async function deleteVideo(lead: LeadPreview) {
    if (!openBatchId) return;
    if (!window.confirm(`Delete the rendered video for ${lead.company}?`)) return;
    setDeletingVideoIds((prev) => new Set(prev).add(lead.id));
    setDetailsError('');
    try {
      const response = await fetch(
        `/api/batches/${encodeURIComponent(openBatchId)}/videos/${encodeURIComponent(lead.id)}`,
        { method: 'DELETE' },
      );
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
        lead?: LeadPreview;
      };
      if (!response.ok || !body.lead) {
        throw new Error(body.error ?? `Delete failed (HTTP ${response.status})`);
      }
      setDetails((current) =>
        current
          ? {
              ...current,
              leads: current.leads.map((candidate) =>
                candidate.id === lead.id ? body.lead! : candidate,
              ),
            }
          : current,
      );
      setBatches((prev) =>
        prev.map((batch) =>
          batch.batchId === openBatchId
            ? {
                ...batch,
                done: Math.max(0, batch.done - 1),
                failed: batch.failed + 1,
              }
            : batch,
        ),
      );
      onVideoDelete?.(openBatchId, lead.id, body.lead);
    } catch (err) {
      setDetailsError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeletingVideoIds((prev) => {
        const next = new Set(prev);
        next.delete(lead.id);
        return next;
      });
    }
  }

  return (
    <div className="panel">
      <div className="panel-header">
        <div className="panel-title">
          <h2>Batch History</h2>
          <span>{loading ? 'Loading…' : error || `${batches.length} total`}</span>
        </div>
        <button className="button ghost" type="button" onClick={refresh} disabled={loading}>
          Refresh
        </button>
      </div>
      <div className="panel-body">
        {batches.length === 0 ? (
          <p className="field-hint">
            {loading ? 'Loading…' : 'No batches yet. Start one above.'}
          </p>
        ) : (
          <ul className="batch-history-list">
            {batches.map((entry) => (
              <li key={entry.batchId} className={`batch-row status-${entry.status}`}>
                <div className="batch-row-summary">
                  <div className="batch-row-main">
                    {editingId === entry.batchId ? (
                      <form
                        className="batch-rename-form"
                        onSubmit={(event) => {
                          event.preventDefault();
                          commitRename(entry);
                        }}
                      >
                        <input
                          className="text-input"
                          autoFocus
                          value={editingValue}
                          onChange={(event) => setEditingValue(event.target.value)}
                          onBlur={() => commitRename(entry)}
                          onKeyDown={(event) => {
                            if (event.key === 'Escape') cancelRename();
                          }}
                        />
                      </form>
                    ) : (
                      <button
                        className="batch-name"
                        type="button"
                        title="Click to rename"
                        onClick={() => beginRename(entry)}
                      >
                        {entry.name || `Batch ${entry.batchId.slice(0, 8)}`}
                      </button>
                    )}
                    <span className="batch-meta">
                      {formatTimestamp(entry.createdAt)} · {entry.done}/{entry.total} done
                      {entry.failed > 0 ? ` · ${entry.failed} failed` : ''} ·{' '}
                      <span className={`status-pill status-${entry.status}`}>{entry.status}</span>
                    </span>
                  </div>
                  <div className="batch-row-actions">
                    <button
                      className="button ghost"
                      type="button"
                      onClick={() => openBatch(entry)}
                    >
                      View
                    </button>
                    <a className="button ghost" href={entry.reportUrl}>
                      Report
                    </a>
                    <a className="button ghost" href={entry.archiveUrl}>
                      ZIP
                    </a>
                    <button
                      className="button ghost danger"
                      type="button"
                      disabled={deletingBatchId === entry.batchId}
                      onClick={() => deleteBatch(entry)}
                    >
                      Delete
                    </button>
                  </div>
                </div>
                {openBatchId === entry.batchId ? (
                  <div className="batch-detail">
                    {detailsLoading ? (
                      <p className="field-hint">Loading batch videos…</p>
                    ) : detailsError ? (
                      <p className="field-hint error-text">{detailsError}</p>
                    ) : details ? (
                      renderedLeads.length > 0 ? (
                        <div className="history-video-stack">
                          {selectedVideoUrl && selectedLead ? (
                            <video
                              key={selectedVideoUrl}
                              className="rendered-video compact"
                              controls
                              playsInline
                              preload="metadata"
                              src={selectedVideoUrl}
                            />
                          ) : null}
                          <div className="history-video-list" aria-label="Rendered videos">
                            {renderedLeads.map((lead) => (
                              <div
                                className={`history-video-row ${
                                  selectedLead?.id === lead.id ? 'active' : ''
                                }`}
                                key={lead.id}
                              >
                                <button
                                  className="history-video-name"
                                  type="button"
                                  onClick={() => setSelectedLeadId(lead.id)}
                                >
                                  <strong>{lead.company}</strong>
                                  <span>
                                    Row {lead.rowIndex + 1} · {lead.website}
                                  </span>
                                </button>
                                <button
                                  className="button ghost danger"
                                  type="button"
                                  disabled={deletingVideoIds.has(lead.id)}
                                  onClick={() => deleteVideo(lead)}
                                >
                                  Delete
                                </button>
                              </div>
                            ))}
                          </div>
                        </div>
                      ) : (
                        <p className="field-hint">No rendered videos remain for this batch.</p>
                      )
                    ) : null}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function formatTimestamp(ms: number): string {
  const d = new Date(ms);
  const today = new Date();
  const sameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate();
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (sameDay) return `Today ${time}`;
  const date = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return `${date} ${time}`;
}

async function readJsonResponse<T extends { error?: string }>(
  response: Response,
): Promise<T> {
  const text = await response.text();
  if (!text.trim()) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    if (response.ok) throw err;
    return {
      error: response.statusText || `HTTP ${response.status}`,
    } as T;
  }
}
