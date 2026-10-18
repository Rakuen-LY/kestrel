import {
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import type { ImageAttachment } from "@kestrel/protocol";
import { imageFilesFrom, imageSrc, toAttachment } from "../images.js";
import { AttachIcon, CloseIcon, SendIcon, StopIcon } from "./icons.js";

const MAX_IMAGES = 6;

export function Composer({
  busy,
  disabled,
  placeholder,
  onSend,
  onCancel,
  onError,
  extensionSlot,
}: {
  busy: boolean;
  disabled?: boolean;
  placeholder?: string;
  onSend: (value: string, images: ImageAttachment[]) => void | Promise<void>;
  onCancel: () => void | Promise<void>;
  onError?: (message: string) => void;
  /** Slot contributions rendered under the composer box. */
  extensionSlot?: ReactNode;
}) {
  const [value, setValue] = useState("");
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const [dragging, setDragging] = useState(false);
  const [reading, setReading] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const element = area.current;
    if (!element) return;
    element.style.height = "0px";
    element.style.height = `${Math.min(element.scrollHeight, 260)}px`;
  }, [value]);

  const addFiles = async (files: File[]) => {
    if (!files.length) return;
    setReading(true);
    const accepted = [...images];
    for (const file of files) {
      if (accepted.length >= MAX_IMAGES) {
        onError?.(`You can attach at most ${MAX_IMAGES} images.`);
        break;
      }
      try {
        const attachment = await toAttachment(file);
        accepted.push(attachment);
        setImages([...accepted]);
      } catch (error) {
        onError?.(error instanceof Error ? error.message : String(error));
      }
    }
    setReading(false);
  };

  const submit = () => {
    if (busy || disabled || reading) return;
    if (!value.trim() && images.length === 0) return;
    const text = value;
    const attached = images;
    setValue("");
    setImages([]);
    void onSend(text, attached);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  };

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = imageFilesFrom(event.clipboardData?.items);
    if (!files.length) return;
    event.preventDefault();
    void addFiles(files);
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    void addFiles(imageFilesFrom(event.dataTransfer?.items));
  };

  const canSend = (value.trim() || images.length > 0) && !busy && !disabled && !reading;

  return (
    <div className="composer-wrap">
      {images.length > 0 && (
        <div className="attachment-row">
          {images.map((image, index) => (
            <figure className="attachment" key={`${image.name ?? image.mimeType}-${index}`}>
              <img src={imageSrc(image)} alt={image.name ?? `attachment ${index + 1}`} />
              <button
                type="button"
                className="attachment-remove"
                aria-label={`Remove ${image.name ?? "image"}`}
                onClick={() => setImages((current) => current.filter((_, at) => at !== index))}
              >
                <CloseIcon size={12} />
              </button>
            </figure>
          ))}
        </div>
      )}
      <div
        className={`composer${busy ? " busy" : ""}${dragging ? " dragging" : ""}`}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        <button
          type="button"
          className="attach-button"
          aria-label="Attach images"
          title="Attach images"
          disabled={disabled || busy || reading || images.length >= MAX_IMAGES}
          onClick={() => picker.current?.click()}
        >
          <AttachIcon size={16} />
        </button>
        <input
          ref={picker}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          multiple
          hidden
          onChange={(event) => {
            void addFiles(imageFilesFrom(event.target.files));
            event.target.value = "";
          }}
        />
        <textarea
          ref={area}
          value={value}
          rows={1}
          disabled={disabled}
          placeholder={placeholder ?? "Describe a task. Enter to send, Shift+Enter for a new line."}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          spellCheck
        />
        {busy ? (
          <button type="button" className="send-button stop" onClick={() => void onCancel()} aria-label="Stop run">
            <StopIcon size={16} />
          </button>
        ) : (
          <button
            type="button"
            className="send-button"
            onClick={submit}
            disabled={!canSend}
            aria-label="Send message"
          >
            <SendIcon size={16} />
          </button>
        )}
      </div>
      {extensionSlot}
      <div className="composer-hint">
        <span>Kestrel can read and modify files in the workspace. Review tool calls before approving risky ones.</span>
        <span className="kbd-hint">Enter ↵</span>
      </div>
    </div>
  );
}
