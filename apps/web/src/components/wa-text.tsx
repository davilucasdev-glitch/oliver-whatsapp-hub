import { Fragment } from 'react';

/** Mostra texto com a formatação do WhatsApp: *negrito*, _itálico_, ~riscado~. */
export function WaText({ text }: { text: string }) {
  return (
    <>
      {text.split('\n').map((line, i) => (
        <Fragment key={i}>
          {i > 0 && <br />}
          {line.split(/(\*[^*\n]+\*|_[^_\n]+_|~[^~\n]+~)/g).map((part, j) => {
            if (/^\*[^*]+\*$/.test(part)) return <strong key={j}>{part.slice(1, -1)}</strong>;
            if (/^_[^_]+_$/.test(part)) return <em key={j}>{part.slice(1, -1)}</em>;
            if (/^~[^~]+~$/.test(part)) return <s key={j}>{part.slice(1, -1)}</s>;
            return <Fragment key={j}>{part}</Fragment>;
          })}
        </Fragment>
      ))}
    </>
  );
}
