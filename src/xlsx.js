const XLSX_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const OFFICE_REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

export function workbookToXlsxBuffer({ sheetName, columns, rows }) {
  const files = [
    ['[Content_Types].xml', contentTypesXml()],
    ['_rels/.rels', packageRelationshipsXml()],
    ['xl/workbook.xml', workbookXml(sheetName)],
    ['xl/_rels/workbook.xml.rels', workbookRelationshipsXml()],
    ['xl/styles.xml', stylesXml()],
    ['xl/worksheets/sheet1.xml', worksheetXml(columns, rows)]
  ];

  return zipStore(files.map(([name, content]) => [name, Buffer.from(content, 'utf8')]));
}

function contentTypesXml() {
  return xmlDocument(`<Types xmlns="${REL_NS.replace('/relationships', '/content-types')}">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`);
}

function packageRelationshipsXml() {
  return xmlDocument(`<Relationships xmlns="${REL_NS}">
  <Relationship Id="rId1" Type="${OFFICE_REL_NS}/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`);
}

function workbookXml(sheetName) {
  return xmlDocument(`<workbook xmlns="${XLSX_NS}" xmlns:r="${OFFICE_REL_NS}">
  <sheets>
    <sheet name="${escapeXml(sheetName)}" sheetId="1" r:id="rId1"/>
  </sheets>
</workbook>`);
}

function workbookRelationshipsXml() {
  return xmlDocument(`<Relationships xmlns="${REL_NS}">
  <Relationship Id="rId1" Type="${OFFICE_REL_NS}/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="${OFFICE_REL_NS}/styles" Target="styles.xml"/>
</Relationships>`);
}

function stylesXml() {
  return xmlDocument(`<styleSheet xmlns="${XLSX_NS}">
  <fonts count="2">
    <font><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/></font>
    <font><b/><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/></font>
  </fonts>
  <fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
  <borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="2">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
  </cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`);
}

function worksheetXml(columns, rows) {
  const rowCount = rows.length + 1;
  const lastColumn = columnName(columns.length);
  const headerCells = columns.map((column, index) => stringCell(index + 1, 1, column.header, 1)).join('');
  const bodyRows = rows.map((row, rowIndex) => {
    const excelRow = rowIndex + 2;
    const cells = columns.map((column, columnIndex) => cell(columnIndex + 1, excelRow, row[column.key])).join('');
    return `<row r="${excelRow}">${cells}</row>`;
  }).join('');

  return xmlDocument(`<worksheet xmlns="${XLSX_NS}">
  <dimension ref="A1:${lastColumn}${rowCount}"/>
  <sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
  <sheetFormatPr defaultRowHeight="15"/>
  <cols>${columns.map((column, index) => `<col min="${index + 1}" max="${index + 1}" width="${column.width || 18}" customWidth="1"/>`).join('')}</cols>
  <sheetData>
    <row r="1">${headerCells}</row>
    ${bodyRows}
  </sheetData>
  <autoFilter ref="A1:${lastColumn}${rowCount}"/>
</worksheet>`);
}

function cell(column, row, value) {
  if (value === undefined || value === null || value === '') return `<c r="${columnName(column)}${row}"/>`;
  if (typeof value === 'boolean') return `<c r="${columnName(column)}${row}" t="b"><v>${value ? 1 : 0}</v></c>`;
  const number = Number(value);
  if (Number.isFinite(number) && String(value).trim() !== '') {
    return `<c r="${columnName(column)}${row}"><v>${number}</v></c>`;
  }
  return stringCell(column, row, value);
}

function stringCell(column, row, value, style = 0) {
  const styleAttribute = style ? ` s="${style}"` : '';
  return `<c r="${columnName(column)}${row}" t="inlineStr"${styleAttribute}><is><t>${escapeXml(value)}</t></is></c>`;
}

function columnName(index) {
  let value = '';
  let current = index;
  while (current > 0) {
    current -= 1;
    value = String.fromCharCode(65 + (current % 26)) + value;
    current = Math.floor(current / 26);
  }
  return value;
}

function xmlDocument(body) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${body}`;
}

function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function zipStore(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const [name, data] of files) {
    const fileName = Buffer.from(name, 'utf8');
    const checksum = crc32(data);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(data.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(fileName.length, 26);
    localHeader.writeUInt16LE(0, 28);
    localParts.push(localHeader, fileName, data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(data.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(fileName.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(centralHeader, fileName);

    offset += localHeader.length + fileName.length + data.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDirectory, end]);
}

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
