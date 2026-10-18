/**
 * A `file.viewer` contribution.
 *
 * The console sends `context.file` (path, mime type, encoding, content) and
 * renders whatever this extension mounts instead of the built-in source view.
 * `match.extensions` keeps the iframe out of the way for other file types.
 */
export default function activate(api) {
  api.register({
    id: "csv-table",
    slot: "file.viewer",
    match: { extensions: ["csv", "tsv"] },
    mount(element, context) {
      const file = context.file;
      if (!file || file.binary || file.encoding !== "utf8") {
        element.textContent = "This file cannot be rendered as a table.";
        return;
      }

      const delimiter = file.path.toLowerCase().endsWith(".tsv") ? "\t" : ",";
      const rows = parseTable(file.content, delimiter);
      if (rows.length === 0) {
        element.textContent = "The file is empty.";
        return;
      }

      const table = document.createElement("table");
      table.className = "csv-table";
      const [header, ...body] = rows;

      const thead = document.createElement("thead");
      const headRow = document.createElement("tr");
      for (const cell of header) {
        const th = document.createElement("th");
        th.textContent = cell;
        headRow.append(th);
      }
      thead.append(headRow);
      table.append(thead);

      const tbody = document.createElement("tbody");
      for (const row of body.slice(0, 1000)) {
        const tr = document.createElement("tr");
        for (let index = 0; index < header.length; index += 1) {
          const td = document.createElement("td");
          td.textContent = row[index] ?? "";
          tr.append(td);
        }
        tbody.append(tr);
      }
      table.append(tbody);
      element.append(table);

      const note = document.createElement("p");
      note.className = "csv-note";
      note.textContent = `${rows.length - 1} rows · ${header.length} columns${
        body.length > 1000 ? " · showing the first 1000" : ""
      }${file.truncated ? " · preview truncated" : ""}`;
      element.append(note);
    },
  });
}

/** RFC 4180-style parsing: quoted cells may contain delimiters and newlines. */
function parseTable(text, delimiter) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === delimiter) {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (char !== "\r") {
      cell += char;
    }
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}
