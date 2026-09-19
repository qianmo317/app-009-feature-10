import { useEffect, useRef, useState } from 'react';
import { useChartStore } from '../store/chartStore';
import { rgbToHex, type RGB } from '../utils/quantize';

const MAX_COLORS = 32; // 颜色数上限
const MAX_STITCHES = 512; // 针数 / 行数上限
const WORKER_TIMEOUT_MS = 30000;

type RowsMode = 'auto' | 'custom';

interface SourceImage {
  url: string;
  name: string;
  width: number;
  height: number;
}

interface Preview {
  cols: number;
  rows: number;
  maxColors: number;
  palette: RGB[];
  indices: Uint16Array;
  counts: number[];
}

interface DialogMsg {
  kind: 'error' | 'info';
  text: string;
}

function validateParam(value: number, label: string, unit: string, max: number): string | null {
  if (!Number.isFinite(value) || !Number.isInteger(value)) return `${label}需为整数`;
  if (value === 0) return `${label}不能为 0`;
  if (value < 0) return `${label}不能为负数`;
  if (value > max) return `${label}超出上限（最多 ${max} ${unit}）`;
  return null;
}

const inputStyle = (invalid: boolean): React.CSSProperties => ({
  width: 64,
  fontSize: 12,
  padding: '2px 4px',
  borderRadius: 4,
  border: `1px solid ${invalid ? '#e74c3c' : '#c8c2b8'}`,
});

const errTextStyle: React.CSSProperties = { fontSize: 11, color: '#c0392b', marginTop: 2 };

export default function ImageImport() {
  const chart = useChartStore((s) => s.getCurrentChart());
  const updateChart = useChartStore((s) => s.updateChart);
  const setSelectedColorIndex = useChartStore((s) => s.setSelectedColorIndex);

  const [targetCols, setTargetCols] = useState(64);
  const [rowsMode, setRowsMode] = useState<RowsMode>('auto');
  const [customRows, setCustomRows] = useState(64);
  const [maxColors, setMaxColors] = useState(8);

  const [source, setSource] = useState<SourceImage | null>(null);
  const [processing, setProcessing] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [dialogMsg, setDialogMsg] = useState<DialogMsg | null>(null);
  const [panelNote, setPanelNote] = useState<DialogMsg | null>(null);

  const fileRef = useRef<HTMLInputElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const timeoutRef = useRef<number | null>(null);
  const sourceUrlRef = useRef<string | null>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement>(null);

  // ---- 参数校验（输入即拦下）----
  const colsError = validateParam(targetCols, '目标针数', '针', MAX_STITCHES);
  const colorsError = validateParam(maxColors, '颜色数', '种', MAX_COLORS);
  const rowsError = rowsMode === 'custom' ? validateParam(customRows, '行数', '行', MAX_STITCHES) : null;
  const autoRows = source && !colsError ? Math.max(1, Math.round((targetCols * source.height) / source.width)) : 0;
  const autoRowsError =
    source && rowsMode === 'auto' && !colsError && autoRows > MAX_STITCHES
      ? `按原图比例算出行数 ${autoRows}，超出上限 ${MAX_STITCHES}，请减少针数或改为自定义行数`
      : null;
  const paramError = colsError ?? colorsError ?? rowsError ?? autoRowsError;
  const effectiveRows = rowsMode === 'auto' ? autoRows : customRows;

  // 参数改动后旧预览即过期，必须重新生成才能应用
  const previewStale =
    !!preview && (preview.cols !== targetCols || preview.rows !== effectiveRows || preview.maxColors !== maxColors);
  const canGenerate = !!source && !paramError && !processing;
  const canApply = !!preview && !previewStale && !paramError && !processing;

  const stopWorker = () => {
    workerRef.current?.terminate();
    workerRef.current = null;
    if (timeoutRef.current !== null) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  };

  const closeDialog = () => {
    stopWorker();
    setProcessing(false);
    if (sourceUrlRef.current) {
      URL.revokeObjectURL(sourceUrlRef.current);
      sourceUrlRef.current = null;
    }
    imgRef.current = null;
    setSource(null);
    setPreview(null);
    setDialogMsg(null);
  };

  // 卸载时清理 worker 与对象 URL
  useEffect(() => {
    return () => {
      workerRef.current?.terminate();
      if (timeoutRef.current !== null) clearTimeout(timeoutRef.current);
      if (sourceUrlRef.current) URL.revokeObjectURL(sourceUrlRef.current);
    };
  }, []);

  // Esc 关闭预览弹窗
  useEffect(() => {
    if (!source) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeDialog();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // 把量化结果画到预览画布
  useEffect(() => {
    const canvas = previewCanvasRef.current;
    if (!canvas || !preview) return;
    canvas.width = preview.cols;
    canvas.height = preview.rows;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const img = ctx.createImageData(preview.cols, preview.rows);
    for (let i = 0; i < preview.indices.length; i++) {
      const [r, g, b] = preview.palette[preview.indices[i]];
      const o = i * 4;
      img.data[o] = r;
      img.data[o + 1] = g;
      img.data[o + 2] = b;
      img.data[o + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  }, [preview]);

  const runQuantize = (img: HTMLImageElement, cols: number, rows: number, colors: number) => {
    stopWorker();
    setDialogMsg(null);
    setProcessing(true);

    const canvas = document.createElement('canvas');
    canvas.width = cols;
    canvas.height = rows;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      setProcessing(false);
      setDialogMsg({ kind: 'error', text: '无法创建绘图环境，当前图解未受影响。' });
      return;
    }
    ctx.drawImage(img, 0, 0, cols, rows);

    let imageData: ImageData;
    try {
      imageData = ctx.getImageData(0, 0, cols, rows);
    } catch {
      setProcessing(false);
      setDialogMsg({ kind: 'error', text: '读取图片像素失败，当前图解未受影响。' });
      return;
    }

    const worker = new Worker(new URL('../workers/quantize.worker.ts', import.meta.url), { type: 'module' });
    workerRef.current = worker;

    timeoutRef.current = window.setTimeout(() => {
      stopWorker();
      setProcessing(false);
      setDialogMsg({
        kind: 'error',
        text: '计算超时：请尝试减小目标针数或颜色数。当前图解未受影响。',
      });
    }, WORKER_TIMEOUT_MS);

    worker.onmessage = (e: MessageEvent) => {
      stopWorker();
      setProcessing(false);
      const data = e.data;
      if (data?.error) {
        setDialogMsg({ kind: 'error', text: `转换失败：${data.error}。当前图解未受影响。` });
        return;
      }
      const palette = data.palette as RGB[] | undefined;
      const indices = data.indices as Uint16Array | undefined;
      if (!palette?.length || !indices?.length) {
        setDialogMsg({ kind: 'error', text: '转换失败：未能从图片中提取颜色。当前图解未受影响。' });
        return;
      }
      const counts = new Array<number>(palette.length).fill(0);
      for (let i = 0; i < indices.length; i++) counts[indices[i]]++;
      setPreview({ cols, rows, maxColors: colors, palette, indices, counts });
    };

    worker.onerror = () => {
      stopWorker();
      setProcessing(false);
      setDialogMsg({ kind: 'error', text: '转换计算出错，请调整参数后重试。当前图解未受影响。' });
    };

    worker.postMessage({ imageData, maxColors: colors });
  };

  const handleFile = async (file: File) => {
    setPanelNote(null);
    if (!file.type.startsWith('image/')) {
      setPanelNote({ kind: 'error', text: '所选文件不是图片，请选择 PNG / JPG / WebP 文件。' });
      return;
    }
    const url = URL.createObjectURL(file);
    const img = new Image();
    try {
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error('decode failed'));
      });
    } catch {
      URL.revokeObjectURL(url);
      setPanelNote({
        kind: 'error',
        text: `图片「${file.name}」加载失败，文件可能已损坏或格式不受支持。当前图解未受影响。`,
      });
      return;
    }
    if (!img.naturalWidth || !img.naturalHeight) {
      URL.revokeObjectURL(url);
      setPanelNote({ kind: 'error', text: '图片内容为空，无法转换。当前图解未受影响。' });
      return;
    }

    closeDialog();
    imgRef.current = img;
    sourceUrlRef.current = url;
    setSource({ url, name: file.name, width: img.naturalWidth, height: img.naturalHeight });
    setPreview(null);

    const rows = rowsMode === 'custom' ? customRows : Math.max(1, Math.round((targetCols * img.naturalHeight) / img.naturalWidth));
    if (paramError || rows > MAX_STITCHES) {
      setDialogMsg({
        kind: 'error',
        text: paramError ?? `按原图比例算出行数 ${rows}，超出上限 ${MAX_STITCHES}，请减少针数或改为自定义行数`,
      });
      return;
    }
    runQuantize(img, targetCols, rows, maxColors);
  };

  const regenerate = () => {
    if (!imgRef.current || !canGenerate) return;
    runQuantize(imgRef.current, targetCols, effectiveRows, maxColors);
  };

  const cancelProcessing = () => {
    stopWorker();
    setProcessing(false);
    setDialogMsg({ kind: 'info', text: '已取消计算，可调整参数后重新生成。当前图解未受影响。' });
  };

  const applyPreview = () => {
    if (!chart || !preview || !canApply) return;
    const newPalette = preview.palette.map((rgb, i) => ({
      id: Math.random().toString(36).slice(2),
      name: `颜色 ${i + 1}`,
      hex: rgbToHex(rgb),
    }));
    updateChart(chart.id, (c) => ({
      ...c,
      cols: preview.cols,
      rows: preview.rows,
      palette: newPalette,
      cells: preview.indices,
    }));
    // 新色板可能更短，收回越界的选中色号
    const selected = useChartStore.getState().selectedColorIndex;
    if (selected >= newPalette.length) setSelectedColorIndex(newPalette.length - 1);
    setPanelNote({
      kind: 'info',
      text: `已应用：${preview.cols} 针 × ${preview.rows} 行 · ${preview.palette.length} 色`,
    });
    closeDialog();
  };

  const orientation = source ? (source.width > source.height ? '横向' : source.width < source.height ? '竖向' : '方形') : '';

  return (
    <div style={{ padding: 12, borderBottom: '1px solid #e0dcd5' }}>
      <h3 style={{ margin: '0 0 8px', fontSize: 14, fontWeight: 600 }}>图片转图解</h3>
      <input
        type="file"
        accept="image/png,image/jpeg,image/webp"
        ref={fileRef}
        style={{ display: 'none' }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) handleFile(file);
          e.target.value = '';
        }}
      />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <button
          onClick={() => {
            setPanelNote(null);
            fileRef.current?.click();
          }}
          disabled={!chart}
          style={{
            padding: '6px 12px',
            fontSize: 12,
            borderRadius: 4,
            border: '1px solid #3498db',
            background: '#3498db',
            color: '#fff',
            cursor: chart ? 'pointer' : 'not-allowed',
            opacity: chart ? 1 : 0.6,
          }}
        >
          导入图片…
        </button>
        <p style={{ margin: 0, fontSize: 11, color: '#888' }}>
          导入后先生成对照预览，确认效果满意再应用到画布。
        </p>
        {panelNote && (
          <div
            style={{
              fontSize: 11,
              padding: '6px 8px',
              borderRadius: 4,
              background: panelNote.kind === 'error' ? '#fdecea' : '#eef6fc',
              color: panelNote.kind === 'error' ? '#c0392b' : '#2c3e50',
              border: `1px solid ${panelNote.kind === 'error' ? '#f5b7b1' : '#aed6f1'}`,
            }}
          >
            {panelNote.text}
          </div>
        )}
      </div>

      {source && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.45)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
          }}
        >
          <div
            style={{
              background: '#fff',
              borderRadius: 8,
              padding: 20,
              width: 760,
              maxWidth: '94vw',
              maxHeight: '92vh',
              overflow: 'auto',
              boxShadow: '0 8px 32px rgba(0,0,0,0.25)',
            }}
          >
            <h3 style={{ margin: '0 0 12px', fontSize: 15, fontWeight: 600 }}>图片转图解 · 对照预览</h3>

            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
              <div style={{ flex: '1 1 300px', minWidth: 0 }}>
                <div style={{ fontSize: 12, color: '#666', marginBottom: 6 }}>
                  原图：{source.name}（{source.width} × {source.height} px · {orientation}）
                </div>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    background: '#faf8f5',
                    border: '1px solid #e0dcd5',
                    borderRadius: 4,
                    minHeight: 120,
                    padding: 8,
                  }}
                >
                  <img src={source.url} alt="原图" style={{ maxWidth: '100%', maxHeight: 300, objectFit: 'contain' }} />
                </div>
              </div>

              <div style={{ flex: '1 1 300px', minWidth: 0 }}>
                <div style={{ fontSize: 12, color: '#666', marginBottom: 6 }}>
                  转换结果
                  {preview && !previewStale && `：${preview.cols} 针 × ${preview.rows} 行 · ${preview.palette.length} 色`}
                </div>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    background: '#faf8f5',
                    border: '1px solid #e0dcd5',
                    borderRadius: 4,
                    minHeight: 120,
                    padding: 8,
                  }}
                >
                  {processing ? (
                    <span style={{ fontSize: 12, color: '#888' }}>正在计算，请稍候…</span>
                  ) : preview ? (
                    <canvas
                      ref={previewCanvasRef}
                      style={{ imageRendering: 'pixelated', maxWidth: '100%', maxHeight: 300, opacity: previewStale ? 0.4 : 1 }}
                    />
                  ) : (
                    <span style={{ fontSize: 12, color: '#888' }}>暂无预览，请修正参数后点击「重新生成预览」</span>
                  )}
                </div>
                {preview && previewStale && !processing && (
                  <div style={{ fontSize: 11, color: '#d68910', marginTop: 4 }}>参数已修改，预览未更新，请重新生成。</div>
                )}
                {preview && !previewStale && (
                  <div style={{ marginTop: 8 }}>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                      {preview.palette.map((rgb, i) => {
                        const hex = rgbToHex(rgb);
                        const pct = ((preview.counts[i] / preview.indices.length) * 100).toFixed(1);
                        return (
                          <span
                            key={i}
                            title={`${hex} · ${preview.counts[i]} 格（${pct}%）`}
                            style={{ width: 18, height: 18, background: hex, border: '1px solid #c8c2b8', borderRadius: 2 }}
                          />
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', marginTop: 16, alignItems: 'flex-start' }}>
              <label style={{ fontSize: 12 }}>
                目标针数
                <div>
                  <input
                    type="number"
                    min={1}
                    max={MAX_STITCHES}
                    value={targetCols}
                    disabled={processing}
                    onChange={(e) => setTargetCols(Number(e.target.value))}
                    style={inputStyle(!!colsError)}
                  />
                </div>
                {colsError && <div style={errTextStyle}>{colsError}</div>}
              </label>

              <div style={{ fontSize: 12 }}>
                行数
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 2 }}>
                  <label style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }}>
                    <input
                      type="radio"
                      name="rows-mode"
                      checked={rowsMode === 'auto'}
                      disabled={processing}
                      onChange={() => setRowsMode('auto')}
                    />
                    按原图比例{rowsMode === 'auto' && !colsError && autoRows > 0 ? `（约 ${autoRows} 行）` : ''}
                  </label>
                  <label style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }}>
                    <input
                      type="radio"
                      name="rows-mode"
                      checked={rowsMode === 'custom'}
                      disabled={processing}
                      onChange={() => setRowsMode('custom')}
                    />
                    自定义
                    <input
                      type="number"
                      min={1}
                      max={MAX_STITCHES}
                      value={customRows}
                      disabled={processing || rowsMode !== 'custom'}
                      onChange={(e) => setCustomRows(Number(e.target.value))}
                      style={inputStyle(rowsMode === 'custom' && !!rowsError)}
                    />
                  </label>
                </div>
                {(rowsError ?? autoRowsError) && <div style={errTextStyle}>{rowsError ?? autoRowsError}</div>}
              </div>

              <label style={{ fontSize: 12 }}>
                最多颜色数（上限 {MAX_COLORS}）
                <div>
                  <input
                    type="number"
                    min={1}
                    max={MAX_COLORS}
                    value={maxColors}
                    disabled={processing}
                    onChange={(e) => setMaxColors(Number(e.target.value))}
                    style={inputStyle(!!colorsError)}
                  />
                </div>
                {colorsError && <div style={errTextStyle}>{colorsError}</div>}
              </label>
            </div>

            {dialogMsg && (
              <div
                style={{
                  marginTop: 12,
                  padding: '8px 10px',
                  borderRadius: 4,
                  fontSize: 12,
                  background: dialogMsg.kind === 'error' ? '#fdecea' : '#eef6fc',
                  color: dialogMsg.kind === 'error' ? '#c0392b' : '#2c3e50',
                  border: `1px solid ${dialogMsg.kind === 'error' ? '#f5b7b1' : '#aed6f1'}`,
                }}
              >
                {dialogMsg.text}
              </div>
            )}

            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 16 }}>
              <span style={{ flex: 1, fontSize: 11, color: '#999' }}>
                应用后将替换当前图解的针数、行数与全部颜色，此操作不可撤销。
              </span>
              {processing ? (
                <button
                  onClick={cancelProcessing}
                  style={{
                    padding: '6px 12px',
                    fontSize: 12,
                    borderRadius: 4,
                    border: '1px solid #e67e22',
                    background: '#fff',
                    color: '#e67e22',
                    cursor: 'pointer',
                  }}
                >
                  取消计算
                </button>
              ) : (
                <button
                  onClick={regenerate}
                  disabled={!canGenerate}
                  style={{
                    padding: '6px 12px',
                    fontSize: 12,
                    borderRadius: 4,
                    border: '1px solid #3498db',
                    background: '#fff',
                    color: '#3498db',
                    cursor: canGenerate ? 'pointer' : 'not-allowed',
                    opacity: canGenerate ? 1 : 0.5,
                  }}
                >
                  重新生成预览
                </button>
              )}
              <button
                onClick={applyPreview}
                disabled={!canApply}
                style={{
                  padding: '6px 12px',
                  fontSize: 12,
                  borderRadius: 4,
                  border: '1px solid #27ae60',
                  background: '#27ae60',
                  color: '#fff',
                  cursor: canApply ? 'pointer' : 'not-allowed',
                  opacity: canApply ? 1 : 0.5,
                }}
              >
                应用到画布
              </button>
              <button
                onClick={closeDialog}
                style={{
                  padding: '6px 12px',
                  fontSize: 12,
                  borderRadius: 4,
                  border: '1px solid #bdc3c7',
                  background: '#ecf0f1',
                  color: '#333',
                  cursor: 'pointer',
                }}
              >
                放弃并关闭
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
