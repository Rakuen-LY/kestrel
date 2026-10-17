import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { SendIcon, StopIcon } from "./icons.js";

export function Composer({
  busy,
  disabled,
  placeholder,
  onSend,
  onCancel,
}: {
  busy: boolean;
  disabled?: boolean;
  placeholder?: string;
  onSend: (value: string) => void | Promise<void>;
  onCancel: () => void | Promise<void>;
}) {
  const [value, setValue] = useState("");
  const area = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const element = area.current;
    if (!element) return;
    element.style.height = "0px";
    element.style.height = `${Math.min(element.scrollHeight, 260)}px`;
  }, [value]);

  const submit = () => {
    if (!value.trim() || busy || disabled) return;
    const text = value;
    setValue("");
    void onSend(text);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <div className="composer-wrap">
      <div className={`composer${busy ? " busy" : ""}`}>
        <textarea
          ref={area}
          value={value}
          rows={1}
          disabled={disabled}
          placeholder={placeholder ?? "Describe a task. Enter to send, Shift+Enter for a new line."}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={onKeyDown}
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
            disabled={!value.trim() || disabled}
            aria-label="Send message"
          >
            <SendIcon size={16} />
          </button>
        )}
      </div>
      <div className="composer-hint">
        <span>Kestrel can read and modify files in the workspace. Review tool calls before approving risky ones.</span>
        <span className="kbd-hint">Enter ↵</span>
      </div>
    </div>
  );
}
