'use client';

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import Papa from 'papaparse';
import type {
  BatchEvent,
  CaptureMode,
  CirclePosition,
  CircleSize,
  LeadStatus,
  RecordingScrollMode,
  Resolution,
} from '@/types';
import { normalizeWebsite } from '@/lib/url';
import { BatchHistoryPanel } from './batch-history-panel';

type CsvRow = Record<string, string>;

interface StartBatchResponse {
  batchId: string;
  total: number;
  skipped: number;
  websiteColumn: string;
  eventsUrl: string;
  reportUrl: string;
  archiveUrl: string;
  error?: string;
}

interface BatchSnapshotResponse {
  batchId: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  total: number;
  reportUrl: string;
  archiveUrl: string;
  eventsUrl: string;
  leads: LeadPreview[];
  error?: string;
}

type BatchErrorEvent = { type: 'batch-error'; error: string };
type CircleSourceMode = 'image' | 'video';

interface CsvDataset {
  fileName: string;
  rows: CsvRow[];
  columns: string[];
  errorCount: number;
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

const MAX_BATCH_LEADS = 1000;
const LAST_BATCH_KEY = 'loom-morph:last-batch-id';
const LEFT_COLUMN_WIDTH_KEY = 'loom-morph:left-column-width';
const RIGHT_COLUMN_WIDTH_KEY = 'loom-morph:right-column-width';
const DEFAULT_LEFT_COLUMN_WIDTH = 330;
const DEFAULT_RIGHT_COLUMN_WIDTH = 313;
const LEFT_COLUMN_BOUNDS = { min: 280, max: 460 };
const RIGHT_COLUMN_BOUNDS = { min: 280, max: 480 };

const SIZE_LABELS: Record<CircleSize, string> = {
  S: '200 px',
  M: '280 px',
  L: '360 px',
};

const BUBBLE_PREVIEW: Record<CircleSize, string> = {
  S: '72px',
  M: '92px',
  L: '112px',
};

const CIRCLE_ACCEPT: Record<CircleSourceMode, string> = {
  image: 'image/png,image/jpeg',
  video: 'video/mp4,video/quicktime,video/webm,video/x-matroska',
};

export function BatchWorkbench() {
  const [csvFile, setCsvFile] = useState<File | null>(null);
  const [circleFile, setCircleFile] = useState<File | null>(null);
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [circleMode, setCircleMode] = useState<CircleSourceMode>('image');
  const [circleHasAudio, setCircleHasAudio] = useState(true);
  const [circlePreviewUrl, setCirclePreviewUrl] = useState('');
  // Source aspect ratio (w/h). Used to size the preview media so BOTH axes
  // overflow the bubble — without this, object-fit:cover makes one axis
  // exact-fit and the X or Y slider does nothing.
  const [circleSourceAR, setCircleSourceAR] = useState(1);
  const [circleCropScale, setCircleCropScale] = useState(1);
  const [circleCropX, setCircleCropX] = useState(0);
  const [circleCropY, setCircleCropY] = useState(0);
  const [csvFileName, setCsvFileName] = useState('');
  const [circleFileName, setCircleFileName] = useState('');
  const [audioFileName, setAudioFileName] = useState('');
  const [csvDataset, setCsvDataset] = useState<CsvDataset | null>(null);
  const [websiteColumn, setWebsiteColumn] = useState('');
  const [companyColumn, setCompanyColumn] = useState('');
  const [leads, setLeads] = useState<LeadPreview[]>([]);
  const [parseMessage, setParseMessage] = useState('Upload a CSV to begin');
  const [prospectLimit, setProspectLimit] = useState(MAX_BATCH_LEADS);
  const [durationSec, setDurationSec] = useState(30);
  const [resolution, setResolution] = useState<Resolution>('1080p');
  // 'screenshot' (fast, parallelizable) vs 'recording' (real motion;
  // needed for sites with hero videos / parallax). See D-019.
  const [captureMode, setCaptureMode] = useState<CaptureMode>('recording');
  const [recordingScrollMode, setRecordingScrollMode] = useState<RecordingScrollMode>('auto');
  const [smoothMotion, setSmoothMotion] = useState(false);
  const [circleSize, setCircleSize] = useState<CircleSize>('M');
  const [circlePosition, setCirclePosition] =
    useState<CirclePosition>('bottom-left');
  const [filenameTemplate, setFilenameTemplate] = useState('{company} and vibeflow.mp4');
  const [batchName, setBatchName] = useState('');
  const [historyRefreshKey, setHistoryRefreshKey] = useState(0);
  const [isRunning, setIsRunning] = useState(false);
  const [batchId, setBatchId] = useState('');
  const [reportUrl, setReportUrl] = useState('');
  const [archiveUrl, setArchiveUrl] = useState('');
  const [runError, setRunError] = useState('');
  const [selectedPreviewLeadId, setSelectedPreviewLeadId] = useState('');
  const [previewWebsite, setPreviewWebsite] = useState('');
  const [leftColumnWidth, setLeftColumnWidth] = useState(DEFAULT_LEFT_COLUMN_WIDTH);
  const [rightColumnWidth, setRightColumnWidth] = useState(DEFAULT_RIGHT_COLUMN_WIDTH);
  const [activeResizeSide, setActiveResizeSide] = useState<'left' | 'right' | null>(null);
  const previewWebsiteTouchedRef = useRef(false);
  const restoredBatchRef = useRef(false);
  const eventSourceRef = useRef<EventSource | null>(null);
  const layoutGridRef = useRef<HTMLDivElement | null>(null);

  const summary = useMemo(() => {
    const done = leads.filter((lead) => lead.status === 'done').length;
    const failed = leads.filter((lead) => lead.status === 'failed').length;
    const active = leads.filter(
      (lead) => lead.status === 'capturing' || lead.status === 'rendering',
    ).length;
    const totalProgress =
      leads.length === 0
        ? 0
        : Math.round(
            leads.reduce((sum, lead) => sum + lead.progress, 0) / leads.length,
          );

    return { done, failed, active, processed: done + failed, totalProgress };
  }, [leads]);

  const websiteColumnStats = useMemo(() => {
    if (!csvDataset || !websiteColumn) return null;

    let usable = 0;
    const rejected: string[] = [];
    for (const row of csvDataset.rows) {
      const raw = (row[websiteColumn] ?? '').trim();
      if (!raw) continue;
      if (normalizeWebsite(raw)) {
        usable += 1;
      } else if (rejected.length < 3) {
        rejected.push(raw);
      }
    }

    return {
      queued: Math.min(usable, prospectLimit, MAX_BATCH_LEADS),
      usable,
      rejected,
    };
  }, [csvDataset, prospectLimit, websiteColumn]);

  // Prospect-limit input is bounded by the global ceiling, not by the CSV's
  // current row count — so the user can set a target (e.g. 500) before
  // uploading the CSV, and a tiny test CSV doesn't snap the field to its
  // row count. The actual queued count is still clamped by the CSV's
  // usable rows in `websiteColumnStats.queued`.
  const maxProspectLimit = MAX_BATCH_LEADS;

  const normalizedPreviewWebsite = useMemo(
    () => normalizeWebsite(previewWebsite) ?? '',
    [previewWebsite],
  );
  const renderedLeads = useMemo(
    () => leads.filter((lead) => lead.status === 'done' && lead.outputPath),
    [leads],
  );
  const selectedRenderedLead = useMemo(
    () =>
      renderedLeads.find((lead) => lead.id === selectedPreviewLeadId) ??
      renderedLeads[0] ??
      null,
    [renderedLeads, selectedPreviewLeadId],
  );
  const selectedRenderedVideoUrl =
    batchId && selectedRenderedLead
      ? `/api/batches/${encodeURIComponent(batchId)}/videos/${encodeURIComponent(
          selectedRenderedLead.id,
        )}`
      : '';
  const canDownloadArchive = archiveUrl !== '' && !isRunning && summary.done > 0;

  useEffect(() => {
    const savedLeft = readStoredColumnWidth(LEFT_COLUMN_WIDTH_KEY, LEFT_COLUMN_BOUNDS);
    const savedRight = readStoredColumnWidth(RIGHT_COLUMN_WIDTH_KEY, RIGHT_COLUMN_BOUNDS);
    if (savedLeft !== null) setLeftColumnWidth(savedLeft);
    if (savedRight !== null) setRightColumnWidth(savedRight);

    return () => {
      eventSourceRef.current?.close();
      eventSourceRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!circleFile) {
      setCirclePreviewUrl('');
      setCircleSourceAR(1);
      return;
    }

    const url = URL.createObjectURL(circleFile);
    setCirclePreviewUrl(url);
    return () => {
      URL.revokeObjectURL(url);
    };
  }, [circleFile]);

  // Probe the source's aspect ratio. Triggers when the preview URL or mode
  // changes. Defaults to 1 (square) on any failure so the bubble still
  // renders cleanly.
  useEffect(() => {
    if (!circlePreviewUrl) {
      setCircleSourceAR(1);
      return;
    }
    let cancelled = false;
    if (circleMode === 'image') {
      const img = new Image();
      img.onload = () => {
        if (cancelled) return;
        const ar = img.naturalHeight === 0 ? 1 : img.naturalWidth / img.naturalHeight;
        setCircleSourceAR(Number.isFinite(ar) && ar > 0 ? ar : 1);
      };
      img.onerror = () => {
        if (!cancelled) setCircleSourceAR(1);
      };
      img.src = circlePreviewUrl;
    } else {
      const video = document.createElement('video');
      video.onloadedmetadata = () => {
        if (cancelled) return;
        const ar = video.videoHeight === 0 ? 1 : video.videoWidth / video.videoHeight;
        setCircleSourceAR(Number.isFinite(ar) && ar > 0 ? ar : 1);
      };
      video.onerror = () => {
        if (!cancelled) setCircleSourceAR(1);
      };
      video.src = circlePreviewUrl;
    }
    return () => {
      cancelled = true;
    };
  }, [circlePreviewUrl, circleMode]);

  useEffect(() => {
    const savedBatchId = window.localStorage.getItem(LAST_BATCH_KEY);
    if (!savedBatchId) return;

    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`/api/batches/${encodeURIComponent(savedBatchId)}`);
        const body = (await response.json()) as BatchSnapshotResponse;
        if (!response.ok) {
          window.localStorage.removeItem(LAST_BATCH_KEY);
          return;
        }
        if (cancelled || body.leads.length === 0) return;

        restoredBatchRef.current = true;
        setBatchId(body.batchId);
        setReportUrl(body.reportUrl);
        setArchiveUrl(body.archiveUrl);
        setRunError('');
        setIsRunning(false);
        setLeads(body.leads);
        setParseMessage(`Restored ${body.total} lead${body.total === 1 ? '' : 's'}`);
        const firstOutput = body.leads.find((lead) => lead.status === 'done' && lead.outputPath);
        setSelectedPreviewLeadId(firstOutput?.id ?? '');
      } catch {
        if (!cancelled) window.localStorage.removeItem(LAST_BATCH_KEY);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!csvDataset) return;

    const parsedLeads = buildLeadPreview(
      csvDataset.rows,
      websiteColumn,
      companyColumn,
      prospectLimit,
    );

    setLeads(parsedLeads);
    setParseMessage(
      csvParseMessage({
        fileName: csvDataset.fileName,
        leadCount: parsedLeads.length,
        errorCount: csvDataset.errorCount,
        hasColumns: csvDataset.columns.length > 0,
        websiteColumn,
      }),
    );
  }, [companyColumn, csvDataset, prospectLimit, websiteColumn]);

  useEffect(() => {
    if (prospectLimit > maxProspectLimit) setProspectLimit(maxProspectLimit);
  }, [maxProspectLimit, prospectLimit]);

  useEffect(() => {
    if (previewWebsiteTouchedRef.current) return;
    setPreviewWebsite(leads[0]?.website ?? '');
  }, [leads]);

  useEffect(() => {
    if (renderedLeads.length === 0) {
      if (selectedPreviewLeadId) setSelectedPreviewLeadId('');
      return;
    }
    if (!renderedLeads.some((lead) => lead.id === selectedPreviewLeadId)) {
      setSelectedPreviewLeadId(renderedLeads[0]!.id);
    }
  }, [renderedLeads, selectedPreviewLeadId]);

  function handleCsv(file: File | undefined) {
    if (!file) return;
    closeBatchEvents();
    setCsvFile(file);
    setCsvFileName(file.name);
    setIsRunning(false);
    setBatchId('');
    setReportUrl('');
    setArchiveUrl('');
    setRunError('');
    setSelectedPreviewLeadId('');
    window.localStorage.removeItem(LAST_BATCH_KEY);

    void file
      .text()
      .then((text) => {
        const parsed = Papa.parse<CsvRow>(text, {
          header: true,
          skipEmptyLines: 'greedy',
          transformHeader: cleanCsvHeader,
          transform: (value) => value.trim(),
        });

        const columns = (parsed.meta.fields ?? []).filter(Boolean);
        const inferredWebsite = inferColumn(columns, isWebsiteHeader);
        const inferredCompany = inferColumn(columns, isCompanyHeader);

        setWebsiteColumn(inferredWebsite);
        setCompanyColumn(inferredCompany);
        setCsvDataset({
          fileName: file.name,
          rows: parsed.data,
          columns,
          errorCount: parsed.errors.length,
        });
      })
      .catch(() => {
        setCsvDataset(null);
        setWebsiteColumn('');
        setCompanyColumn('');
        setLeads([]);
        setParseMessage(`Could not read ${file.name}`);
      });
  }

  function resetRun() {
    closeBatchEvents();
    setIsRunning(false);
    setBatchId('');
    setReportUrl('');
    setArchiveUrl('');
    setRunError('');
    setSelectedPreviewLeadId('');
    window.localStorage.removeItem(LAST_BATCH_KEY);
    setLeads((current) =>
      current.map((lead) => ({
        ...lead,
        status: 'pending',
        progress: 0,
        outputPath: undefined,
        error: undefined,
      })),
    );
  }

  function clearRunResult() {
    closeBatchEvents();
    setIsRunning(false);
    setBatchId('');
    setReportUrl('');
    setArchiveUrl('');
    setRunError('');
    setSelectedPreviewLeadId('');
    window.localStorage.removeItem(LAST_BATCH_KEY);
  }

  function handleCircleMode(nextMode: CircleSourceMode) {
    if (nextMode === circleMode && circleFile) return;
    setCircleMode(nextMode);
    setCircleHasAudio(nextMode === 'video');
    setCircleFile(null);
    setCircleFileName('');
    clearRunResult();
  }

  function handleCircleFile(file: File | null) {
    if (!file) return;
    const inferredMode = inferCircleMode(file) ?? circleMode;
    setCircleMode(inferredMode);
    setCircleHasAudio(inferredMode === 'video');
    setCircleFile(file);
    setCircleFileName(file.name);
    clearRunResult();
  }

  async function startRun() {
    if (!csvFile || !circleFile || !websiteColumn) return;

    closeBatchEvents();
    setRunError('');
    setBatchId('');
    setReportUrl('');
    setArchiveUrl('');
    setSelectedPreviewLeadId('');
    setLeads((current) =>
      current.map((lead) => ({
        ...lead,
        id: `csv-${lead.rowIndex + 1}`,
        status: 'pending',
        progress: 0,
        outputPath: undefined,
        error: undefined,
      })),
    );
    setIsRunning(true);

    const form = new FormData();
    form.set('csv', csvFile);
    form.set('circle', circleFile);
    if (audioFile) form.set('audio', audioFile);
    form.set('circleHasAudio', circleMode === 'video' && circleHasAudio ? 'true' : 'false');
    form.set('websiteColumn', websiteColumn);
    form.set('durationSec', String(durationSec));
    form.set('resolution', resolution);
    form.set('circlePosition', circlePosition);
    form.set('circleSize', circleSize);
    form.set('circleMargin', '40');
    form.set('circleCropScale', String(circleCropScale));
    form.set('circleCropX', String(circleCropX));
    form.set('circleCropY', String(circleCropY));
    form.set('captureMode', captureMode);
    form.set('recordingScrollMode', recordingScrollMode);
    form.set('smoothMotion', smoothMotion ? 'true' : 'false');
    form.set('filenameTemplate', filenameTemplate);
    form.set('maxLeads', String(prospectLimit));
    if (batchName.trim()) form.set('name', batchName.trim());

    try {
      const response = await fetch('/api/batches', {
        method: 'POST',
        body: form,
      });
      const body = (await response.json()) as StartBatchResponse;
      if (!response.ok) {
        throw new Error(body.error ?? 'Could not start batch');
      }

      setBatchId(body.batchId);
      setReportUrl(body.reportUrl);
      setArchiveUrl(body.archiveUrl);
      window.localStorage.setItem(LAST_BATCH_KEY, body.batchId);
      // Pop the new batch into the history panel immediately so the user
      // sees it without manually refreshing.
      setHistoryRefreshKey((n) => n + 1);
      subscribeToBatch(body.eventsUrl);
    } catch (err) {
      setIsRunning(false);
      setRunError(err instanceof Error ? err.message : String(err));
    }
  }

  function subscribeToBatch(eventsUrl: string) {
    closeBatchEvents();
    const source = new EventSource(eventsUrl);
    eventSourceRef.current = source;
    source.onmessage = (message) => {
      const event = JSON.parse(message.data) as BatchEvent | BatchErrorEvent;
      if (event.type === 'batch-error') {
        setRunError(event.error);
        setIsRunning(false);
        source.close();
        if (eventSourceRef.current === source) eventSourceRef.current = null;
        return;
      }
      applyBatchEvent(event);
      if (event.type === 'batch-completed') {
        setIsRunning(false);
        source.close();
        if (eventSourceRef.current === source) eventSourceRef.current = null;
      }
    };
    source.onerror = () => {
      setRunError('Lost batch event stream');
      setIsRunning(false);
      source.close();
      if (eventSourceRef.current === source) eventSourceRef.current = null;
    };
  }

  function applyBatchEvent(event: BatchEvent) {
    if (event.type === 'lead-status') {
      setLeads((current) =>
        updateLeadStatus(current, event.leadId, event.status, event.error),
      );
    }
    if (event.type === 'lead-completed') {
      setLeads((current) => updateLeadCompleted(current, event.leadId, event.outputPath));
    }
  }

  function closeBatchEvents() {
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
  }

  async function openHistoryBatch(historyBatchId: string) {
    closeBatchEvents();
    setRunError('');
    try {
      const response = await fetch(`/api/batches/${encodeURIComponent(historyBatchId)}`, {
        cache: 'no-store',
      });
      const body = (await response.json()) as BatchSnapshotResponse;
      if (!response.ok) throw new Error(body.error ?? 'Could not open batch');

      const running = body.status === 'pending' || body.status === 'running';
      setBatchId(body.batchId);
      setReportUrl(body.reportUrl);
      setArchiveUrl(body.archiveUrl);
      setIsRunning(running);
      setLeads(body.leads);
      setParseMessage(`Opened ${body.total} lead${body.total === 1 ? '' : 's'}`);
      const firstOutput = body.leads.find((lead) => lead.status === 'done' && lead.outputPath);
      setSelectedPreviewLeadId(firstOutput?.id ?? '');
      window.localStorage.setItem(LAST_BATCH_KEY, body.batchId);
      if (running) subscribeToBatch(body.eventsUrl);
    } catch (err) {
      setRunError(err instanceof Error ? err.message : String(err));
    }
  }

  function handleHistoryBatchDeleted(deletedBatchId: string) {
    setHistoryRefreshKey((n) => n + 1);
    if (deletedBatchId !== batchId) return;
    closeBatchEvents();
    setIsRunning(false);
    setBatchId('');
    setReportUrl('');
    setArchiveUrl('');
    setSelectedPreviewLeadId('');
    setLeads([]);
    window.localStorage.removeItem(LAST_BATCH_KEY);
  }

  function handleHistoryVideoDeleted(
    deletedBatchId: string,
    leadId: string,
    updatedLead: LeadPreview,
  ) {
    setHistoryRefreshKey((n) => n + 1);
    if (deletedBatchId !== batchId) return;
    setLeads((current) =>
      current.map((lead) => (lead.id === leadId ? { ...lead, ...updatedLead } : lead)),
    );
  }

  function startColumnResize(side: 'left' | 'right', event: ReactPointerEvent) {
    const grid = layoutGridRef.current;
    if (!grid) return;
    event.preventDefault();
    setActiveResizeSide(side);

    const onPointerMove = (moveEvent: PointerEvent) => {
      const rect = grid.getBoundingClientRect();
      if (side === 'left') {
        const width = clampNumber(
          moveEvent.clientX - rect.left,
          LEFT_COLUMN_BOUNDS.min,
          LEFT_COLUMN_BOUNDS.max,
        );
        setLeftColumnWidth(width);
      } else {
        const width = clampNumber(
          rect.right - moveEvent.clientX,
          RIGHT_COLUMN_BOUNDS.min,
          RIGHT_COLUMN_BOUNDS.max,
        );
        setRightColumnWidth(width);
      }
    };

    const onPointerUp = (upEvent: PointerEvent) => {
      const rect = grid.getBoundingClientRect();
      let finalWidth: number;
      if (side === 'left') {
        finalWidth = clampNumber(
          upEvent.clientX - rect.left,
          LEFT_COLUMN_BOUNDS.min,
          LEFT_COLUMN_BOUNDS.max,
        );
        setLeftColumnWidth(finalWidth);
        window.localStorage.setItem(LEFT_COLUMN_WIDTH_KEY, String(Math.round(finalWidth)));
      } else {
        finalWidth = clampNumber(
          rect.right - upEvent.clientX,
          RIGHT_COLUMN_BOUNDS.min,
          RIGHT_COLUMN_BOUNDS.max,
        );
        setRightColumnWidth(finalWidth);
        window.localStorage.setItem(RIGHT_COLUMN_WIDTH_KEY, String(Math.round(finalWidth)));
      }
      setActiveResizeSide(null);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
  }

  const canStart =
    leads.length > 0 &&
    csvFile !== null &&
    circleFile !== null &&
    websiteColumn !== '' &&
    !isRunning;

  return (
    <div className="workbench">
      <header className="topbar">
        <div className="brand-lockup" aria-label="Loom Morph">
          <div className="brand-mark" aria-hidden="true">
            LM
          </div>
        </div>
        <div className="topbar-actions">
          <button className="button" type="button" onClick={resetRun}>
            <span className="icon" aria-hidden="true">
              R
            </span>
            Reset
          </button>
          <button
            className="button primary"
            type="button"
            disabled={!canStart}
            onClick={startRun}
          >
            <span className="icon" aria-hidden="true">
              ▶
            </span>
            Start Batch
          </button>
        </div>
      </header>

      <div
        className={`layout-grid${activeResizeSide ? ' is-resizing' : ''}`}
        ref={layoutGridRef}
        style={
          {
            '--left-column-width': `${leftColumnWidth}px`,
            '--right-column-width': `${rightColumnWidth}px`,
          } as CSSProperties
        }
      >
        <aside className="history-column" aria-label="Batch history and configuration">
          <BatchHistoryPanel
            onDelete={handleHistoryBatchDeleted}
            onOpen={openHistoryBatch}
            onVideoDelete={handleHistoryVideoDeleted}
            refreshKey={historyRefreshKey}
          />
          <div className="panel">
            <div className="panel-header">
              <div className="panel-title">
                <h2>Circle</h2>
                <span>{labelPosition(circlePosition)}</span>
              </div>
            </div>
            <div className="panel-body stack">
              <div className="field">
                <div className="field-label">Circle Size</div>
                <div className="segmented three" role="group" aria-label="Circle size">
                  {(['S', 'M', 'L'] as CircleSize[]).map((item) => (
                    <button
                      className={`segment ${circleSize === item ? 'active' : ''}`}
                      key={item}
                      type="button"
                      onClick={() => setCircleSize(item)}
                    >
                      {SIZE_LABELS[item]}
                    </button>
                  ))}
                </div>
              </div>

              <div className="field">
                <div className="field-label">Circle Position</div>
                <div className="corner-grid">
                  {(
                    [
                      'top-left',
                      'top-right',
                      'bottom-left',
                      'bottom-right',
                    ] as CirclePosition[]
                  ).map((item) => (
                    <button
                      className={`corner-button ${
                        circlePosition === item ? 'active' : ''
                      }`}
                      key={item}
                      type="button"
                      onClick={() => setCirclePosition(item)}
                    >
                      {labelPosition(item)}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
          <div className="panel">
            <div className="panel-header">
              <div className="panel-title">
                <h2>Preview</h2>
                <span>{resolution}</span>
              </div>
            </div>
            <div className="panel-body">
              <div className="preview-controls">
                <div className="field">
                  <label htmlFor="preview-website">Preview website</label>
                  <input
                    className="text-input"
                    id="preview-website"
                    value={previewWebsite}
                    onChange={(event) => {
                      previewWebsiteTouchedRef.current = true;
                      setPreviewWebsite(event.target.value);
                    }}
                    onBlur={() => {
                      setPreviewWebsite(normalizeWebsite(previewWebsite) ?? previewWebsite);
                    }}
                  />
                </div>
                <div className="crop-controls">
                  <div className="circle-crop-editor">
                    <div className="field-label">Crop Preview</div>
                    <CircleCropPreview
                      className="crop-detail-bubble"
                      mode={circleMode}
                      previewUrl={circlePreviewUrl}
                      sizePx={152}
                      sourceAR={circleSourceAR}
                      cropScale={circleCropScale}
                      cropX={circleCropX}
                      cropY={circleCropY}
                    />
                  </div>
                  <div className="crop-slider-grid">
                    <div className="field crop-slider-wide">
                      <label htmlFor="circle-crop-scale">Circle crop</label>
                      <input
                        className="range-input"
                        id="circle-crop-scale"
                        min={1}
                        max={2.5}
                        step={0.05}
                        type="range"
                        value={circleCropScale}
                        onChange={(event) => setCircleCropScale(Number(event.target.value))}
                      />
                    </div>
                    <div className="field">
                      <label htmlFor="circle-crop-x">X</label>
                      <input
                        className="range-input"
                        id="circle-crop-x"
                        min={-100}
                        max={100}
                        step={1}
                        type="range"
                        value={circleCropX}
                        onChange={(event) => setCircleCropX(Number(event.target.value))}
                      />
                    </div>
                    <div className="field">
                      <label htmlFor="circle-crop-y">Y</label>
                      <input
                        className="range-input"
                        id="circle-crop-y"
                        min={-100}
                        max={100}
                        step={1}
                        type="range"
                        value={circleCropY}
                        onChange={(event) => setCircleCropY(Number(event.target.value))}
                      />
                    </div>
                  </div>
                </div>
              </div>
              <div className="preview-frame">
                <div className="browser-bar">
                  <span className="dot" />
                  <span className="dot" />
                  <span className="dot" />
                  {normalizedPreviewWebsite ? (
                    <span className="browser-address">{normalizedPreviewWebsite}</span>
                  ) : null}
                </div>
                {normalizedPreviewWebsite ? (
                  <iframe
                    className="preview-website-frame"
                    loading="lazy"
                    referrerPolicy="no-referrer"
                    sandbox="allow-scripts allow-same-origin"
                    src={normalizedPreviewWebsite}
                    title="Preview website"
                  />
                ) : (
                  <div className="mock-site">
                    <div className="mock-hero" />
                    <div className="mock-line" />
                    <div className="mock-line short" />
                    <div className="mock-grid">
                      <div className="mock-block" />
                      <div className="mock-block" />
                      <div className="mock-block" />
                    </div>
                  </div>
                )}
                <div
                  className={`face-bubble bubble-${circlePosition}`}
                  style={
                    {
                      '--bubble-size': BUBBLE_PREVIEW[circleSize],
                      '--bubble-margin': '18px',
                    } as CSSProperties
                  }
                >
                  <CircleCropPreview
                    mode={circleMode}
                    previewUrl={circlePreviewUrl}
                    sizePx={parseInt(BUBBLE_PREVIEW[circleSize], 10)}
                    sourceAR={circleSourceAR}
                    cropScale={circleCropScale}
                    cropX={circleCropX}
                    cropY={circleCropY}
                  />
                </div>
              </div>
            </div>
          </div>
          <ConfigSummary
            audioFileName={audioFileName}
            captureMode={captureMode}
            circleFileName={circleFileName}
            circleHasAudio={circleHasAudio}
            circleMode={circleMode}
            circlePosition={circlePosition}
            circleSize={circleSize}
            durationSec={durationSec}
            filenameTemplate={filenameTemplate}
            leadsCount={leads.length}
            resolution={resolution}
          />
        </aside>

        <div
          aria-label="Resize batch history"
          aria-orientation="vertical"
          className={`resize-handle ${activeResizeSide === 'left' ? 'active' : ''}`}
          onPointerDown={(event) => startColumnResize('left', event)}
          role="separator"
        />

        <section className="run-column" aria-label="Batch run">
          <div className="summary-strip">
            <Metric label="Selected" value={String(leads.length)} />
            <Metric label="Processed" value={`${summary.processed}/${leads.length}`} />
            <Metric label="Active" value={String(summary.active)} />
            <Metric label="Done" value={String(summary.done)} />
            <Metric label="Failed" value={String(summary.failed)} />
          </div>

          <div className="panel rendered-panel">
            <div className="panel-header">
              <div className="panel-title">
                <h2>Rendered Video</h2>
                <span>
                  {selectedRenderedLead
                    ? selectedRenderedLead.company
                    : `${renderedLeads.length} ready`}
                </span>
              </div>
              {renderedLeads.length > 1 ? (
                <div className="rendered-picker" aria-label="Rendered videos">
                  {renderedLeads.map((lead) => (
                    <button
                      className={`segment ${
                        selectedRenderedLead?.id === lead.id ? 'active' : ''
                      }`}
                      key={lead.id}
                      type="button"
                      onClick={() => setSelectedPreviewLeadId(lead.id)}
                    >
                      {lead.rowIndex + 1}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
            <div className="panel-body">
              {selectedRenderedVideoUrl && selectedRenderedLead ? (
                <div className="rendered-preview">
                  <video
                    key={selectedRenderedVideoUrl}
                    className="rendered-video"
                    controls
                    playsInline
                    preload="metadata"
                    src={selectedRenderedVideoUrl}
                  />
                </div>
              ) : (
                <div className="video-empty">
                  <strong>No rendered video</strong>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    alt=""
                    className="video-empty-gif"
                    src="/what-huh.gif"
                  />
                  <span>{isRunning ? 'Rendering' : 'Waiting'}</span>
                </div>
              )}
            </div>
          </div>

          <div className="panel progress-panel">
            <div className="panel-header">
              <div className="panel-title">
                <h2>Batch Progress</h2>
                <span>{batchId ? batchId.slice(0, 8) : `${summary.totalProgress}%`}</span>
              </div>
              <div className="toolbar">
                <a
                  className={`button ${canDownloadArchive ? '' : 'disabled-link'}`}
                  href={archiveUrl || '#'}
                  aria-disabled={!canDownloadArchive}
                  download={batchId ? `${batchId}-videos.zip` : undefined}
                  tabIndex={canDownloadArchive ? undefined : -1}
                  onClick={(event) => {
                    if (!canDownloadArchive) event.preventDefault();
                  }}
                  title={
                    canDownloadArchive
                      ? `Download ${summary.done} rendered video${
                          summary.done === 1 ? '' : 's'
                        } as a zip`
                      : 'Batch zip is available after the run finishes with at least one rendered video'
                  }
                >
                  <span className="icon" aria-hidden="true">
                    ↓
                  </span>
                  Download ZIP
                </a>
                <a
                  className={`button ${reportUrl && !isRunning ? '' : 'disabled-link'}`}
                  href={reportUrl || '#'}
                  aria-disabled={!reportUrl || isRunning}
                  tabIndex={reportUrl && !isRunning ? undefined : -1}
                  onClick={(event) => {
                    if (!reportUrl || isRunning) event.preventDefault();
                  }}
                >
                  <span className="icon" aria-hidden="true">
                    #
                  </span>
                  Report
                </a>
              </div>
            </div>
            <div className="panel-body stack">
              <div className="progress-track" aria-label="Overall progress">
                <div
                  className="progress-fill"
                  style={{ width: `${summary.totalProgress}%` }}
                />
              </div>

              {leads.length > 0 ? (
                <div className="table-wrap">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Row</th>
                        <th>Company</th>
                        <th>Website</th>
                        <th>Status</th>
                        <th>Progress</th>
                        <th>Output</th>
                      </tr>
                    </thead>
                    <tbody>
                      {leads.map((lead) => (
                        <tr key={lead.id}>
                          <td>{lead.rowIndex + 1}</td>
                          <td>{lead.company}</td>
                          <td className="url-cell">{lead.website}</td>
                          <td>
                            <span className={`status-pill status-${lead.status}`}>
                              {lead.status}
                            </span>
                          </td>
                          <td>
                            <div className="progress-track">
                              <div
                                className="progress-fill"
                                style={{ width: `${lead.progress}%` }}
                              />
                            </div>
                          </td>
                          <td>
                            {lead.error ? (
                              lead.error
                            ) : lead.outputPath && batchId ? (
                              <button
                                className="button small"
                                type="button"
                                onClick={() => setSelectedPreviewLeadId(lead.id)}
                              >
                                Preview
                              </button>
                            ) : (
                              '-'
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="empty-state">
                  <div>
                    <strong>No leads</strong>
                    <p>
                      {csvDataset
                        ? 'Choose the column that contains each lead website.'
                        : 'Upload a CSV with lead websites.'}
                    </p>
                  </div>
                </div>
              )}
            </div>
          </div>
        </section>

        <div
          aria-label="Resize settings"
          aria-orientation="vertical"
          className={`resize-handle ${activeResizeSide === 'right' ? 'active' : ''}`}
          onPointerDown={(event) => startColumnResize('right', event)}
          role="separator"
        />

        <aside className="setup-column" aria-label="Batch setup">
          <div className="panel">
            <div className="panel-header">
              <div className="panel-title">
                <h2>Inputs</h2>
                <span>{runError || parseMessage}</span>
              </div>
            </div>
            <div className="panel-body stack">
              <div className="field">
                <label htmlFor="batch-name">Batch name</label>
                <input
                  className="text-input"
                  id="batch-name"
                  type="text"
                  placeholder="e.g. Q2 outreach — Acme"
                  value={batchName}
                  onChange={(event) => setBatchName(event.target.value)}
                />
                <span className="field-hint">
                  Leave blank to auto-name from today's date. You can rename later from the history list.
                </span>
              </div>
              <div className="field">
                <label htmlFor="csv-file">Lead CSV</label>
                <StyledFileInput
                  accept=".csv,text/csv"
                  id="csv-file"
                  label="Select CSV"
                  value={csvFileName}
                  placeholder="No CSV selected"
                  onSelect={handleCsv}
                />
              </div>
              <div className="field">
                <label htmlFor="circle-file">Circle Source</label>
                <div className="segmented" role="group" aria-label="Circle source type">
                  {(['image', 'video'] as CircleSourceMode[]).map((item) => (
                    <button
                      className={`segment ${circleMode === item ? 'active' : ''}`}
                      key={item}
                      type="button"
                      onClick={() => handleCircleMode(item)}
                    >
                      {item[0]!.toUpperCase() + item.slice(1)}
                    </button>
                  ))}
                </div>
                <StyledFileInput
                  accept={CIRCLE_ACCEPT[circleMode]}
                  id="circle-file"
                  label="Select source"
                  value={circleFileName}
                  placeholder="No source selected"
                  onSelect={(file) => handleCircleFile(file ?? null)}
                />
                {circleMode === 'video' ? (
                  <label className="check-row">
                    <input
                      type="checkbox"
                      checked={circleHasAudio}
                      onChange={(event) => {
                        const next = event.target.checked;
                        setCircleHasAudio(next);
                        // Drop any previously selected MP3 so the chip + form
                        // submission stay consistent with what's effective.
                        if (next) {
                          setAudioFile(null);
                          setAudioFileName('');
                        }
                      }}
                    />
                    <span>Use circle video audio</span>
                  </label>
                ) : null}
              </div>
              <div className="field">
                <label htmlFor="audio-file">Narration MP3</label>
                <StyledFileInput
                  accept="audio/mpeg"
                  disabled={circleMode === 'video' && circleHasAudio}
                  id="audio-file"
                  label="Select MP3"
                  value={audioFileName}
                  placeholder="No narration selected"
                  onSelect={(file) => {
                    if (!file) return;
                    setAudioFile(file);
                    setAudioFileName(file.name);
                  }}
                />
                {circleMode === 'video' && circleHasAudio ? (
                  <span className="field-hint">
                    Disabled — using circle video audio. Output length matches the circle.
                  </span>
                ) : (
                  <span className="field-hint">
                    Output length matches the MP3.
                  </span>
                )}
              </div>
              {csvDataset && csvDataset.columns.length > 0 ? (
                <div className="mapper-grid">
                  <div className="field">
                    <label htmlFor="website-column">Website column</label>
                    <select
                      className="select-input"
                      id="website-column"
                      value={websiteColumn}
                      onChange={(event) => setWebsiteColumn(event.target.value)}
                    >
                      <option value="">Select column</option>
                      {csvDataset.columns.map((column) => (
                        <option key={column} value={column}>
                          {column}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="field">
                    <label htmlFor="company-column">Company column</label>
                    <select
                      className="select-input"
                      id="company-column"
                      value={companyColumn}
                      onChange={(event) => setCompanyColumn(event.target.value)}
                    >
                      <option value="">None</option>
                      {csvDataset.columns.map((column) => (
                        <option key={column} value={column}>
                          {column}
                        </option>
                      ))}
                    </select>
                  </div>
                  {websiteColumnStats ? (
                    <div className="mapper-note">
                      <strong>
                        {websiteColumnStats.queued > 0
                          ? `${websiteColumnStats.queued} selected`
                          : 'No usable websites'}
                      </strong>
                      <span>
                        {websiteColumnStats.usable > MAX_BATCH_LEADS
                          ? `${websiteColumnStats.usable} valid rows found, capped at ${MAX_BATCH_LEADS}.`
                          : `${websiteColumnStats.usable} valid row${
                              websiteColumnStats.usable === 1 ? '' : 's'
                            } found.`}
                      </span>
                      {websiteColumnStats.rejected.length > 0 ? (
                        <span>
                          Rejected: {websiteColumnStats.rejected.join(', ')}
                        </span>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              ) : null}
              <div className="file-list">
                <FileChip label="CSV" value={csvFileName || 'sample.csv'} />
                <FileChip label="Circle" value={circleFileName || 'required'} />
                <FileChip label="Audio" value={audioFileName || 'none'} />
              </div>
            </div>
          </div>

          <div className="panel">
            <div className="panel-header">
              <div className="panel-title">
                <h2>Video Settings</h2>
                <span>{durationSec}s</span>
              </div>
            </div>
            <div className="panel-body stack">
              <div className="field-row">
                <div className="field">
                  <label htmlFor="prospect-limit">Prospects to process</label>
                  <input
                    className="text-input"
                    id="prospect-limit"
                    min={1}
                    max={maxProspectLimit}
                    type="number"
                    value={prospectLimit}
                    onChange={(event) =>
                      setProspectLimit(
                        clampNumber(Number(event.target.value) || 1, 1, maxProspectLimit),
                      )
                    }
                  />
                </div>
                <div className="field">
                  <label htmlFor="duration">Duration</label>
                  <input
                    className="text-input"
                    id="duration"
                    min={1}
                    max={300}
                    type="number"
                    value={durationSec}
                    onChange={(event) =>
                      setDurationSec(Number(event.target.value) || 30)
                    }
                  />
                </div>
              </div>

              <div className="field">
                <label htmlFor="filename-template">Filename</label>
                <input
                  className="text-input"
                  id="filename-template"
                  value={filenameTemplate}
                  onChange={(event) => setFilenameTemplate(event.target.value)}
                />
              </div>

              <div className="field">
                <div className="field-label">Capture Mode</div>
                <div className="segmented" role="group" aria-label="Capture mode">
                  {(['screenshot', 'recording'] as CaptureMode[]).map((item) => (
                    <button
                      className={`segment ${captureMode === item ? 'active' : ''}`}
                      key={item}
                      type="button"
                      onClick={() => setCaptureMode(item)}
                      title={
                        item === 'screenshot'
                          ? 'Pans a static screenshot — fast, parallel-friendly. Hero videos and animations are frozen at their loaded frame.'
                          : 'Records the live page — captures hero videos, parallax, autoplay backgrounds. Slower (real-time-bound).'
                      }
                    >
                      {item === 'screenshot' ? 'Static' : 'Live'}
                    </button>
                  ))}
                </div>
              </div>

              {captureMode === 'recording' ? (
                <div className="field">
                  <div className="field-label">Live capture scroll</div>
                  <div className="segmented" role="group" aria-label="Recording scroll mode">
                    {(['auto', 'pan', 'static'] as RecordingScrollMode[]).map((item) => (
                      <button
                        className={`segment ${recordingScrollMode === item ? 'active' : ''}`}
                        key={item}
                        type="button"
                        onClick={() => setRecordingScrollMode(item)}
                        title={
                          item === 'auto'
                            ? 'Probes the page; scrolls if it responds, holds at top if it doesn’t (scroll-locked sites, single-screen pages).'
                            : item === 'pan'
                              ? 'Always scrolls — useful if the auto-detect picks wrong.'
                              : 'Always holds at top — best for sites whose hero animates wildly on scroll (agency/brand sites).'
                        }
                      >
                        {item === 'auto' ? 'Auto' : item === 'pan' ? 'Scroll' : 'Hold at top'}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}

              {captureMode === 'recording' ? (
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={smoothMotion}
                    onChange={(event) => setSmoothMotion(event.target.checked)}
                  />
                  <span title="Adds motion-interpolation (ffmpeg minterpolate=blend) to the rendered output so the on-page hero video reads as smooth motion. Adds roughly 50% to render time.">
                    Smooth hero-video motion (slower render)
                  </span>
                </label>
              ) : null}

              <div className="field">
                <div className="field-label">Resolution</div>
                <div className="segmented" role="group" aria-label="Resolution">
                  {(['1080p', '720p'] as Resolution[]).map((item) => (
                    <button
                      className={`segment ${resolution === item ? 'active' : ''}`}
                      key={item}
                      type="button"
                      onClick={() => setResolution(item)}
                    >
                      {item}
                    </button>
                  ))}
                </div>
              </div>

            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function FileChip({ label, value }: { label: string; value: string }) {
  return (
    <div className="file-chip">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function StyledFileInput({
  accept,
  disabled = false,
  id,
  label,
  onSelect,
  placeholder,
  value,
}: {
  accept: string;
  disabled?: boolean;
  id: string;
  label: string;
  onSelect: (file: File | undefined) => void;
  placeholder: string;
  value: string;
}) {
  return (
    <label
      className={`file-picker${disabled ? ' disabled' : ''}${value ? ' has-file' : ''}`}
      htmlFor={id}
    >
      <input
        accept={accept}
        className="native-file-input"
        disabled={disabled}
        id={id}
        type="file"
        onChange={(event) => {
          onSelect(event.target.files?.[0]);
          event.currentTarget.value = '';
        }}
      />
      <span className="file-picker-icon" aria-hidden="true">
        ↑
      </span>
      <span className="file-picker-copy">
        <strong>{label}</strong>
        <span>{value || placeholder}</span>
      </span>
    </label>
  );
}

function ConfigSummary({
  audioFileName,
  captureMode,
  circleFileName,
  circleHasAudio,
  circleMode,
  circlePosition,
  circleSize,
  durationSec,
  filenameTemplate,
  leadsCount,
  resolution,
}: {
  audioFileName: string;
  captureMode: CaptureMode;
  circleFileName: string;
  circleHasAudio: boolean;
  circleMode: CircleSourceMode;
  circlePosition: CirclePosition;
  circleSize: CircleSize;
  durationSec: number;
  filenameTemplate: string;
  leadsCount: number;
  resolution: Resolution;
}) {
  return (
    <div className="sidebar-section">
      <div className="sidebar-heading">Configuration</div>
      <div className="config-list">
        <ConfigRow label="Inputs" value={`${leadsCount} lead${leadsCount === 1 ? '' : 's'}`} />
        <ConfigRow label="Output" value={`${durationSec}s · ${resolution}`} />
        <ConfigRow label="Filename" value={filenameTemplate} />
        <ConfigRow label="Source" value={circleFileName || `required ${circleMode}`} />
        <ConfigRow
          label="Audio"
          value={
            circleMode === 'video' && circleHasAudio
              ? 'circle audio'
              : audioFileName || 'none'
          }
        />
        <ConfigRow label="Mode" value={captureMode === 'recording' ? 'live capture' : 'static'} />
        <ConfigRow label="Position" value={labelPosition(circlePosition).toLowerCase()} />
        <ConfigRow label="Circle size" value={SIZE_LABELS[circleSize]} />
      </div>
    </div>
  );
}

function ConfigRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="config-row">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function CircleCropPreview({
  className,
  mode,
  previewUrl,
  sizePx,
  sourceAR,
  cropScale,
  cropX,
  cropY,
}: {
  className?: string;
  mode: CircleSourceMode;
  previewUrl: string;
  sizePx: number;
  sourceAR: number;
  cropScale: number;
  cropX: number;
  cropY: number;
}) {
  const mediaLayout = computeCircleMediaLayout({
    bubblePx: sizePx,
    sourceAR,
    cropScale,
    cropX,
    cropY,
  });
  const mediaStyle: CSSProperties = {
    position: 'absolute',
    width: `${mediaLayout.width}px`,
    height: `${mediaLayout.height}px`,
    left: `${mediaLayout.left}px`,
    top: `${mediaLayout.top}px`,
  };

  return (
    <div
      className={`circle-crop-preview${className ? ` ${className}` : ''}`}
      style={{ '--crop-preview-size': `${sizePx}px` } as CSSProperties}
    >
      {previewUrl ? (
        mode === 'image' ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            alt=""
            className="face-bubble-media"
            src={previewUrl}
            style={mediaStyle}
          />
        ) : (
          <video
            aria-label="Circle source preview"
            autoPlay
            className="face-bubble-media"
            loop
            muted
            playsInline
            src={previewUrl}
            style={mediaStyle}
          />
        )
      ) : null}
    </div>
  );
}

// Base zoom keeps both axes overflowing the bubble once the user edits crop
// position or scale. Matches CROP_BASE_ZOOM in filter-graph.ts, including the
// renderer's default no-custom-crop path.
const PREVIEW_BASE_ZOOM = 1.25;

function computeCircleMediaLayout(opts: {
  bubblePx: number;
  sourceAR: number; // width / height of source
  cropScale: number; // user-facing scale slider (≥1)
  cropX: number; // -100..100; +100 = right side of source visible
  cropY: number; // -100..100; +100 = bottom of source visible
}): { width: number; height: number; left: number; top: number } {
  const { bubblePx, sourceAR, cropScale, cropX, cropY } = opts;
  const hasCustomCrop =
    Math.abs(cropScale - 1) > 0.0001 || cropX !== 0 || cropY !== 0;
  const effectiveScale =
    Math.max(1, cropScale) * (hasCustomCrop ? PREVIEW_BASE_ZOOM : 1);
  const shorterDim = bubblePx * effectiveScale;
  const width = sourceAR >= 1 ? shorterDim * sourceAR : shorterDim;
  const height = sourceAR >= 1 ? shorterDim : shorterDim / sourceAR;
  const panMaxX = (width - bubblePx) / 2;
  const panMaxY = (height - bubblePx) / 2;
  // Positive X exposes the right side of the source — shift image left.
  const left = (bubblePx - width) / 2 + (-cropX / 100) * panMaxX;
  const top = (bubblePx - height) / 2 + (-cropY / 100) * panMaxY;
  return { width, height, left, top };
}

function labelPosition(position: CirclePosition): string {
  return position
    .split('-')
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join(' ');
}

function cleanCsvHeader(header: string): string {
  return header.replace(/^\uFEFF/, '').trim();
}

function inferColumn(
  columns: string[],
  predicate: (column: string) => boolean,
): string {
  return columns.find(predicate) ?? '';
}

function inferCircleMode(file: File): CircleSourceMode | null {
  const type = file.type.toLowerCase();
  const name = file.name.toLowerCase();
  if (type.startsWith('video/') || /\.(mp4|mov|webm|mkv)$/.test(name)) {
    return 'video';
  }
  if (type.startsWith('image/') || /\.(png|jpe?g)$/.test(name)) {
    return 'image';
  }
  return null;
}

function buildLeadPreview(
  rows: CsvRow[],
  selectedWebsiteColumn: string,
  selectedCompanyColumn: string,
  limit: number = MAX_BATCH_LEADS,
): LeadPreview[] {
  if (!selectedWebsiteColumn) return [];

  return rows
    .map((row, index): LeadPreview | null => {
      const website = normalizePreviewWebsite(row[selectedWebsiteColumn] ?? '');
      if (!website) return null;
      const companyValue = selectedCompanyColumn
        ? row[selectedCompanyColumn]
        : undefined;

      return {
        id: `csv-${index + 1}`,
        rowIndex: index,
        website,
        company: companyValue || `Lead ${index + 1}`,
        status: 'pending',
        progress: 0,
      };
    })
    .filter((lead): lead is LeadPreview => lead !== null)
    .slice(0, Math.min(limit, MAX_BATCH_LEADS));
}

function isWebsiteHeader(header: string): boolean {
  const compact = header
    .replace(/^\uFEFF/, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

  return (
    compact === 'website' ||
    compact === 'url' ||
    compact === 'websiteurl' ||
    compact === 'site' ||
    compact === 'domain' ||
    compact === 'companywebsite' ||
    compact === 'companydomain'
  );
}

function isCompanyHeader(header: string): boolean {
  const compact = header
    .replace(/^\uFEFF/, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

  return (
    compact === 'company' ||
    compact === 'companyname' ||
    compact === 'account' ||
    compact === 'organization' ||
    compact === 'name'
  );
}

function normalizePreviewWebsite(value: string): string {
  return normalizeWebsite(value) ?? '';
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function readStoredColumnWidth(
  key: string,
  bounds: { min: number; max: number },
): number | null {
  const raw = window.localStorage.getItem(key);
  if (!raw) return null;
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value)) return null;
  return clampNumber(value, bounds.min, bounds.max);
}

function csvParseMessage({
  fileName,
  leadCount,
  errorCount,
  hasColumns,
  websiteColumn,
}: {
  fileName: string;
  leadCount: number;
  errorCount: number;
  hasColumns: boolean;
  websiteColumn: string;
}): string {
  if (!hasColumns) return `No columns found in ${fileName}`;
  if (!websiteColumn) return 'Choose website column';
  if (leadCount === 0) return `No usable websites in ${websiteColumn}`;
  const leadText = `${leadCount} lead${leadCount === 1 ? '' : 's'} ready`;
  if (errorCount === 0) return leadText;
  return `${leadText}, ${errorCount} row warning${errorCount === 1 ? '' : 's'}`;
}

function updateLeadStatus(
  leads: LeadPreview[],
  leadId: string,
  status: LeadStatus,
  error?: string,
): LeadPreview[] {
  const existingIndex = leads.findIndex((lead) => lead.id === leadId);
  const targetIndex =
    existingIndex >= 0
      ? existingIndex
      : firstLeadForStatus(leads, status);

  if (targetIndex < 0) return leads;

  return leads.map((lead, index) => {
    if (index !== targetIndex) return lead;
    return {
      ...lead,
      id: leadId,
      status,
      progress: progressForStatus(status),
      outputPath: status === 'failed' ? undefined : lead.outputPath,
      error,
    };
  });
}

function updateLeadCompleted(
  leads: LeadPreview[],
  leadId: string,
  outputPath: string,
): LeadPreview[] {
  const existingIndex = leads.findIndex((lead) => lead.id === leadId);
  const targetIndex =
    existingIndex >= 0
      ? existingIndex
      : leads.findIndex((lead) => lead.status === 'rendering');

  if (targetIndex < 0) return leads;

  return leads.map((lead, index) => {
    if (index !== targetIndex) return lead;
    return {
      ...lead,
      id: leadId,
      status: 'done',
      progress: 100,
      outputPath,
      error: undefined,
    };
  });
}

function firstLeadForStatus(leads: LeadPreview[], status: LeadStatus): number {
  if (status === 'capturing') {
    return leads.findIndex((lead) => lead.status === 'pending');
  }
  if (status === 'rendering') {
    return leads.findIndex((lead) => lead.status === 'capturing');
  }
  if (status === 'failed') {
    const active = leads.findIndex(
      (lead) => lead.status === 'capturing' || lead.status === 'rendering',
    );
    return active >= 0 ? active : leads.findIndex((lead) => lead.status === 'pending');
  }
  return leads.findIndex((lead) => lead.status === 'pending');
}

function progressForStatus(status: LeadStatus): number {
  switch (status) {
    case 'capturing':
      return 35;
    case 'rendering':
      return 72;
    case 'done':
      return 100;
    case 'failed':
      return 100;
    case 'pending':
      return 0;
  }
}

function renderFilename(template: string, lead: LeadPreview): string {
  const fallback = `lead-${lead.rowIndex + 1}.mp4`;
  if (!template.trim()) return fallback;
  const resolved = template
    .replaceAll('{company}', lead.company)
    .replaceAll('{i}', String(lead.rowIndex + 1))
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
    .trim();

  if (!resolved) return fallback;
  return /\.mp4$/i.test(resolved) ? resolved : `${resolved}.mp4`;
}
