import { HardDrive } from 'lucide-react';
import type { ModelsResponse, LocalModel, DaemonStatus } from '../types';

interface Props {
  models: ModelsResponse;
  status: DaemonStatus | null;
  onOptimize: () => Promise<void>;
  onToast: (msg: string) => void;
}

const formatMB = (mb?: number | null): string => {
  if (mb === undefined || mb === null || isNaN(mb) || !isFinite(mb)) return '—';
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${Math.round(mb)} MB`;
};

function fmtLastUsed(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const diffMs = Date.now() - d.getTime();
  const diffH  = diffMs / 3_600_000;
  if (diffH < 1)    return 'Used recently';
  if (diffH < 24)   return `Used ${Math.floor(diffH)}h ago`;
  const diffD = Math.floor(diffH / 24);
  return diffD === 1 ? 'Used yesterday' : `Used ${diffD}d ago`;
}

function ModelCard({ model, onPrepare }: { model: LocalModel; onPrepare: () => void }) {
  const lastUsed = fmtLastUsed(model.last_used);
  const mbToFree = model.mb_to_free ?? 0;

  const showQuant = model.quantization && model.quantization !== 'UNKNOWN';
  const showParam = model.parameter_count && model.parameter_count !== 'UNKNOWN';

  return (
    <div className={`model-card tilt-card${model.can_fit ? ' model-can-fit' : ' model-no-fit'}`}>
      <div className="model-card-header">
        <div className="model-name-wrap">
          <div className="model-name">{model.name}</div>
          {lastUsed && <div className="model-last-used">{lastUsed}</div>}
        </div>
        {model.can_fit
          ? <div className="model-badge model-badge--fit">Fits in RAM</div>
          : <div className="model-badge model-badge--nofit">Too large</div>
        }
      </div>

      {(showQuant || showParam) && (
        <div className="model-meta-row">
          {showParam && (
            <span className="model-meta-item model-quant">{model.parameter_count}</span>
          )}
          {showQuant && (
            <span className="model-meta-item model-quant">{model.quantization}</span>
          )}
        </div>
      )}

      {/* RAM breakdown */}
      {(model.estimated_ram_mb || model.estimated_kv_cache_mb) && (
        <div className="model-ram-breakdown">
          {model.estimated_ram_mb && (
            <div className="model-ram-item">
              <span className="model-ram-label">Weights</span>
              <span className="model-ram-value">{formatMB(model.estimated_ram_mb)}</span>
            </div>
          )}
          {model.estimated_kv_cache_mb && (
            <div className="model-ram-item">
              <span className="model-ram-label">KV Cache</span>
              <span className="model-ram-value">{formatMB(model.estimated_kv_cache_mb)}</span>
            </div>
          )}
          {model.total_required_mb && (
            <div className="model-ram-item">
              <span className="model-ram-label">Total required</span>
              <span className="model-ram-value">{formatMB(model.total_required_mb)}</span>
            </div>
          )}
        </div>
      )}

      {!model.can_fit && mbToFree > 0 && (
        <div className="model-need-free">
          Need{' '}
          <span className="model-need-free-val" style={{ color: '#ea580c' }}>
            {formatMB(mbToFree)} more
          </span>
        </div>
      )}

      {!model.can_fit && (
        <button className="model-prepare-btn" onClick={onPrepare}>
          Prepare Memory
        </button>
      )}
    </div>
  );
}

// Context fill indicator (shown when Ollama is running)
function ContextBanner({ status }: { status: DaemonStatus }) {
  const fill = status.context_fill_percent;
  const mins = status.context_minutes_remaining;
  const warn = status.context_warning_level ?? 0;
  const rate = status.context_growth_rate;

  if (!fill || fill <= 0) return null;

  const warnColor = warn >= 2 ? '#ef4444' : warn >= 1 ? '#f97316' : '#D4AF37';

  return (
    <div className="context-banner" style={{ borderColor: `${warnColor}33` }}>
      <div className="context-banner-header">
        <span className="context-banner-label">Context Window</span>
        <span className="context-banner-pct" style={{ color: warnColor }}>{fill.toFixed(0)}% full</span>
      </div>
      <div className="context-fill-track">
        <div
          className="context-fill-bar"
          style={{ width: `${Math.min(fill, 100)}%`, background: warnColor }}
        />
      </div>
      <div className="context-banner-meta">
        {rate && rate > 0 && <span>Growing at {rate.toFixed(1)}%/min</span>}
        {mins && mins > 0 && (
          <span style={{ color: warn >= 1 ? warnColor : 'var(--text-faint)' }}>
            {mins.toFixed(0)} min until full
          </span>
        )}
      </div>
    </div>
  );
}

export function Models({ models, status, onOptimize, onToast }: Props) {
  const availableMb = models.total_available_mb;
  const fittable    = models.models.filter(m => m.can_fit);
  const notFittable = models.models.filter(m => !m.can_fit);

  const handlePrepare = async () => {
    await onOptimize();
    onToast('Freeing memory for model…');
  };

  return (
    <div className="view">
      {/* Context banner — only when Ollama is active */}
      {status?.ai_inference_active && status && (
        <ContextBanner status={status} />
      )}

      {/* RAM availability header */}
      <div className="models-ram-card tilt-card">
        <div className="models-ram-header">
          <div className="models-ram-label">Available for Models</div>
          <div className="models-ram-value">{formatMB(availableMb)}</div>
        </div>
        <div className="models-ram-bar-track">
          <div className="models-ram-bar-fill" style={{ width: '100%' }} />
        </div>
      </div>

      {models.models.length === 0 ? (
        <div className="models-empty">
          <div className="models-empty-icon"><HardDrive size={32} strokeWidth={1.25} /></div>
          <div className="models-empty-title">No local models found</div>
          <div className="models-empty-sub">Install a model with Ollama or LM Studio to see it here</div>
        </div>
      ) : (
        <>
          {fittable.length > 0 && (
            <div className="models-section">
              <div className="section-header">
                <span className="section-title">Ready to Run</span>
                <span className="section-count">{fittable.length}</span>
              </div>
              <div className="models-grid">
                {fittable.map(m => (
                  <ModelCard key={m.name} model={m} onPrepare={handlePrepare} />
                ))}
              </div>
            </div>
          )}

          {notFittable.length > 0 && (
            <div className="models-section">
              <div className="section-header">
                <span className="section-title">Need More RAM</span>
                <span className="section-count">{notFittable.length}</span>
              </div>
              <div className="models-grid">
                {notFittable.map(m => (
                  <ModelCard key={m.name} model={m} onPrepare={handlePrepare} />
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
