import { useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { CheckIcon, CopyIcon } from "./icons.js";

function CodeBlock({ language, code }: { language: string; code: string }): ReactNode {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access can be denied; the code stays selectable.
    }
  };
  return (
    <div className="codeblock">
      <div className="codeblock-bar">
        <span>{language || "text"}</span>
        <button type="button" onClick={() => void copy()} className="icon-button subtle" aria-label="Copy code">
          {copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
        </button>
      </div>
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  );
}

export function Markdown({ children }: { children: string }): ReactNode {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ children: label, ...props }) => (
            <a {...props} target="_blank" rel="noreferrer noopener">
              {label}
            </a>
          ),
          pre: ({ children: content }) => <>{content}</>,
          code: ({ className, children: content, ...props }) => {
            const text = String(content ?? "");
            const match = /language-([\w-]+)/.exec(className ?? "");
            if (text.includes("\n") || match) {
              return <CodeBlock language={match?.[1] ?? ""} code={text.replace(/\n$/, "")} />;
            }
            return (
              <code className="inline-code" {...props}>
                {text}
              </code>
            );
          },
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
