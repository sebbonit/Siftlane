import { Image as ImageIcon, X } from "lucide-react";
import { formatBytes } from "../lib/format";
import { previewDataUrl } from "../lib/media";
import type { PreviewFile } from "../types";

export function ImagePreview({ file, onClose }: { file: PreviewFile; onClose: () => void }) {
  return (
    <div className="editor-overlay" role="dialog" aria-modal="true" aria-label={`Preview ${file.name}`}>
      <section className="image-preview-dialog">
        <header className="editor-header">
          <div className="editor-file-title">
            <span className="editor-file-icon">
              <ImageIcon size={16} />
            </span>
            <div>
              <strong>{file.name}</strong>
              <small>{file.path}</small>
            </div>
          </div>
          <div className="editor-meta">
            <span>{file.mime.replace("image/", "").toUpperCase()}</span>
            <span>{formatBytes(file.size)}</span>
            <button aria-label="Close preview" onClick={onClose}>
              <X size={17} />
            </button>
          </div>
        </header>
        <div className="image-preview-stage">
          <img src={previewDataUrl(file.mime, file.data_base64)} alt={file.name} />
        </div>
        <footer className="editor-footer">
          <span>Image preview</span>
          <div className="dialog-actions">
            <button className="secondary" onClick={onClose}>
              Close
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}
