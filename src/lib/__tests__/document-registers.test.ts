import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  INCOMING_REGISTER_COLUMNS,
  OUTGOING_REGISTER_COLUMNS,
  formatRegisterDate,
  registerColumns,
  registerRows,
  registerTitle,
  toCsv,
  type IncomingRegisterEntry,
  type OutgoingRegisterEntry,
  type RegisterColumn,
} from "../documents/register-export.ts";

const BOM = "﻿";
const COLS: RegisterColumn[] = [
  { key: "a", header: "A" },
  { key: "b", header: "B" },
];

/** CSV body without the BOM, split into lines (the trailing CRLF dropped). */
function lines(csv: string): string[] {
  return csv.slice(BOM.length).replace(/\r\n$/, "").split("\r\n");
}

describe("register columns (Phụ lục IV)", () => {
  it("has 10 columns for each register", () => {
    assert.equal(INCOMING_REGISTER_COLUMNS.length, 10);
    assert.equal(OUTGOING_REGISTER_COLUMNS.length, 10);
  });

  it("uses the Vietnamese headers", () => {
    assert.deepEqual(
      INCOMING_REGISTER_COLUMNS.map((c) => c.header),
      [
        "Ngày đến",
        "Số đến",
        "Tác giả",
        "Số, ký hiệu",
        "Ngày tháng văn bản",
        "Tên loại và trích yếu nội dung",
        "Đơn vị hoặc người nhận",
        "Ngày chuyển",
        "Ký nhận",
        "Ghi chú",
      ]
    );
    assert.deepEqual(
      OUTGOING_REGISTER_COLUMNS.map((c) => c.header),
      [
        "Số, ký hiệu văn bản",
        "Ngày tháng văn bản",
        "Tên loại và trích yếu nội dung",
        "Người ký",
        "Nơi nhận văn bản",
        "Đơn vị, người nhận bản lưu",
        "Số lượng bản",
        "Ngày chuyển",
        "Ký nhận",
        "Ghi chú",
      ]
    );
  });

  it("has unique keys and picks the columns by direction", () => {
    for (const cols of [INCOMING_REGISTER_COLUMNS, OUTGOING_REGISTER_COLUMNS]) {
      assert.equal(new Set(cols.map((c) => c.key)).size, cols.length);
    }
    assert.equal(registerColumns("incoming"), INCOMING_REGISTER_COLUMNS);
    assert.equal(registerColumns("outgoing"), OUTGOING_REGISTER_COLUMNS);
    assert.equal(registerColumns("internal"), OUTGOING_REGISTER_COLUMNS);
  });
});

describe("registerTitle", () => {
  it("names the register and its year", () => {
    assert.equal(registerTitle({ direction: "incoming", year: 2026 }), "SỔ ĐĂNG KÝ VĂN BẢN ĐẾN — Năm 2026");
    assert.equal(registerTitle({ direction: "outgoing", year: 2027 }), "SỔ ĐĂNG KÝ VĂN BẢN ĐI — Năm 2027");
    assert.equal(registerTitle({ direction: "internal", year: 2026 }), "SỔ ĐĂNG KÝ VĂN BẢN NỘI BỘ — Năm 2026");
  });
});

describe("toCsv", () => {
  it("starts with a UTF-8 BOM and ends lines with CRLF", () => {
    const csv = toCsv(COLS, [{ a: 1, b: 2 }]);
    assert.ok(csv.startsWith(BOM));
    assert.equal(csv, `${BOM}A,B\r\n1,2\r\n`);
    // the BOM encodes to EF BB BF
    assert.deepEqual([...Buffer.from(csv, "utf8").subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  });

  it("quotes commas, quotes and line breaks (RFC 4180)", () => {
    const csv = toCsv(COLS, [
      { a: "Bộ Tài chính, Sở Kế hoạch", b: 'Về việc "khẩn"' },
      { a: "Dòng 1\nDòng 2", b: "CR\rLF" },
    ]);
    assert.deepEqual(lines(csv), [
      "A,B",
      '"Bộ Tài chính, Sở Kế hoạch","Về việc ""khẩn"""',
      '"Dòng 1\nDòng 2","CR\rLF"',
    ]);
  });

  it("keeps Vietnamese text as is and leaves plain cells unquoted", () => {
    const csv = toCsv(COLS, [{ a: "Quyết định về việc nâng lương", b: "Nguyễn Văn Ân" }]);
    assert.deepEqual(lines(csv), ["A,B", "Quyết định về việc nâng lương,Nguyễn Văn Ân"]);
  });

  it("quotes headers that need it and prints empty values as empty cells", () => {
    const csv = toCsv(
      [
        { key: "n", header: "Số, ký hiệu" },
        { key: "x", header: "Ghi chú" },
      ],
      [{ n: null }, { n: undefined, x: "" }]
    );
    assert.deepEqual(lines(csv), ['"Số, ký hiệu",Ghi chú', ",", ","]);
  });

  it("guards cells that a spreadsheet would run as formulas", () => {
    const csv = toCsv(COLS, [
      { a: "=SUM(A1)", b: "@cmd" },
      { a: "+84 90", b: "-x" },
      { a: "- Như trên", b: -5 },
    ]);
    assert.deepEqual(lines(csv), ["A,B", "'=SUM(A1),'@cmd", "'+84 90,'-x", "- Như trên,-5"]);
  });

  it("prints date columns as dd/MM/yyyy", () => {
    const cols: RegisterColumn[] = [
      { key: "d", header: "Ngày", kind: "date" },
      { key: "t", header: "Ngày chuyển", kind: "date" },
      { key: "s", header: "Text" },
    ];
    const csv = toCsv(cols, [
      // 17:30 UTC on 31 Dec is already 1 Jan in Vietnam (UTC+7)
      { d: "2026-03-05", t: "2026-12-31T17:30:00Z", s: "2026-03-05" },
      { d: null, t: "2026-01-02 08:00:00+07", s: "x" },
    ]);
    assert.deepEqual(lines(csv), ["Ngày,Ngày chuyển,Text", "05/03/2026,01/01/2027,2026-03-05", ",02/01/2026,x"]);
  });

  it("uses the given time zone for timestamps", () => {
    const cols: RegisterColumn[] = [{ key: "t", header: "T", kind: "date" }];
    assert.deepEqual(lines(toCsv(cols, [{ t: "2026-12-31T17:30:00Z" }], "UTC")), ["T", "31/12/2026"]);
  });
});

describe("formatRegisterDate", () => {
  it("formats days, timestamps and dates", () => {
    assert.equal(formatRegisterDate("2026-01-09"), "09/01/2026");
    assert.equal(formatRegisterDate(new Date("2026-06-15T03:00:00Z")), "15/06/2026");
    assert.equal(formatRegisterDate(null), "");
    assert.equal(formatRegisterDate(""), "");
    assert.equal(formatRegisterDate("not a date"), "not a date");
  });

  it("falls back to Asia/Ho_Chi_Minh for an unknown zone", () => {
    assert.equal(formatRegisterDate("2026-12-31T17:30:00Z", "Mars/Base"), "01/01/2027");
  });
});

describe("registerRows", () => {
  it("joins type and subject, labels the status and leaves Ký nhận blank", () => {
    const entry: OutgoingRegisterEntry = {
      id: "1",
      readable: true,
      number: 1,
      notation: "01/QĐ-ABC",
      issued_date: "2026-03-01",
      type_name: "Quyết định",
      subject: "Nâng lương, thưởng",
      signer: "KT. Alice",
      recipients: "Bộ Tài chính, Sở Kế hoạch",
      filed_unit: "Hành chính",
      copies: 2,
      sent_at: "2026-03-01T03:00:00Z",
      note: "issued",
    };
    const [row] = registerRows([entry]);
    assert.equal(row.type_subject, "Quyết định: Nâng lương, thưởng");
    assert.equal(row.note, "Issued (Đã ban hành)");
    assert.equal(row.signature, "");
    assert.deepEqual(lines(toCsv(OUTGOING_REGISTER_COLUMNS, [row])).slice(1), [
      '01/QĐ-ABC,01/03/2026,"Quyết định: Nâng lương, thưởng",KT. Alice,"Bộ Tài chính, Sở Kế hoạch",Hành chính,2,01/03/2026,,Issued (Đã ban hành)',
    ]);
  });

  it("prints a restricted row with its numbers and dates only", () => {
    const entry: IncomingRegisterEntry = {
      id: "2",
      readable: false,
      arrival_date: "2026-04-02",
      arrival_number: 7,
      issuing_org_name: null,
      notation: null,
      issued_date: "2026-04-01",
      type_name: null,
      subject: "Restricted document",
      receiver: null,
      transferred_at: null,
      note: null,
    };
    const csv = toCsv(INCOMING_REGISTER_COLUMNS, registerRows([entry]));
    assert.deepEqual(lines(csv).slice(1), ["02/04/2026,7,,,01/04/2026,Restricted document,,,,"]);
    assert.equal(lines(csv)[1].split(",").length, 10);
  });
});
