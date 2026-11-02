import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { strFromU8, unzipSync } from "fflate";
import {
  MAX_EXPORT_FILE_BYTES,
  MAX_FILE_NAME_LENGTH,
  dedupeNames,
  dossierZipName,
  indexCsv,
  manifestJson,
  packDossierZip,
  pad3,
  pickExportFile,
  planDossierExport,
  safeFileName,
  skippedSummary,
  zipEntryName,
} from "../documents/dossier-export.ts";
import {
  RESTRICTED_DOCUMENT_LABEL,
  buildDossierManifest,
  type DossierDocument,
  type DossierDocumentReadable,
} from "../documents/dossiers.ts";

const BOM = "﻿";

function doc(
  ordinal: number,
  subject: string,
  dates: { issued?: string | null; arrival?: string | null } = {},
  extra: Partial<DossierDocumentReadable> = {}
): DossierDocumentReadable {
  return {
    document_id: `doc-${ordinal}`,
    ordinal,
    subject,
    notation: `${ordinal}/QĐ-ABC`,
    arrival_number: null,
    direction: "outgoing",
    status: "issued",
    issued_date: dates.issued ?? null,
    arrival_date: dates.arrival ?? null,
    type_name: "Quyết định",
    readable: true,
    ...extra,
  };
}

const restricted = (ordinal: number): DossierDocument => ({
  document_id: `hidden-${ordinal}`,
  ordinal,
  readable: false,
});

const dossier = { code: "01.HCNS", title: "Hồ sơ hợp đồng", start_date: "2026-01-02", end_date: null, retention_years: 10 };

describe("safeFileName", () => {
  it("replaces / \\ : * ? \" < > | and control characters", () => {
    assert.equal(safeFileName('a/b\\c:d*e?f"g<h>i|j.pdf'), "a b c d e f g h i j.pdf");
    assert.equal(safeFileName("tab\there\nnew\u0000line\u007f.txt"), "tab here new line.txt");
  });

  it("keeps Vietnamese letters and normalises them to NFC", () => {
    assert.equal(safeFileName("Quyết định số 01.pdf"), "Quyết định số 01.pdf");
    const decomposed = "Quyết.pdf"; // NFD 'ế'
    assert.equal(safeFileName(decomposed), "Quyết.pdf");
    assert.equal(safeFileName(decomposed), "Quyết.pdf".normalize("NFC"));
  });

  it("collapses whitespace and trims dots and spaces at both ends", () => {
    assert.equal(safeFileName("  ..Báo   cáo .. "), "Báo cáo");
    assert.equal(safeFileName("report.pdf."), "report.pdf");
  });

  it("falls back for empty names and prefixes reserved Windows names", () => {
    assert.equal(safeFileName(""), "file");
    assert.equal(safeFileName("///"), "file");
    assert.equal(safeFileName("...", 120, "dossier.zip"), "dossier.zip");
    assert.equal(safeFileName("CON"), "_CON");
    assert.equal(safeFileName("nul.txt"), "_nul.txt");
    assert.equal(safeFileName("console.txt"), "console.txt");
  });

  it("limits the length to 120 characters and keeps the extension", () => {
    const long = `${"Văn bản ".repeat(30)}cuối.docx`;
    const result = safeFileName(long);
    assert.equal(Array.from(result).length <= MAX_FILE_NAME_LENGTH, true);
    assert.ok(result.endsWith(".docx"));
    assert.ok(result.startsWith("Văn bản Văn bản"));
    assert.ok(!/\s\.docx$/.test(result), "no space before the extension");
  });

  it("counts characters, not UTF-16 units, and never splits a letter", () => {
    const result = safeFileName(`${"😀".repeat(200)}.pdf`, 10);
    assert.equal(result, `${"😀".repeat(6)}.pdf`);
  });

  it("treats a very long 'extension' as part of the name", () => {
    const result = safeFileName(`a.${"x".repeat(200)}`, 20);
    assert.equal(result, `a.${"x".repeat(18)}`);
  });

  it("leaves short clean names alone", () => {
    assert.equal(safeFileName("Quyet dinh.pdf"), "Quyet dinh.pdf");
  });
});

describe("pad3 and zipEntryName", () => {
  it("pads ordinals to three digits", () => {
    assert.equal(pad3(3), "003");
    assert.equal(pad3(42), "042");
    assert.equal(pad3(1234), "1234");
  });

  it("builds '003_Quyet dinh.pdf' style names with safe characters", () => {
    assert.equal(zipEntryName(3, "Quyet dinh.pdf"), "003_Quyet dinh.pdf");
    assert.equal(zipEntryName(12, "Tờ trình: kế hoạch?.docx"), "012_Tờ trình kế hoạch.docx");
  });

  it("names the archive after the dossier code and title", () => {
    assert.equal(dossierZipName("01.HCNS", "Hồ sơ hợp đồng"), "01.HCNS_Hồ sơ hợp đồng.zip");
    assert.equal(dossierZipName("02/KT", 'Báo cáo "Quý 1"'), "02 KT_Báo cáo Quý 1.zip");
    const long = dossierZipName("03.KT", "x".repeat(400));
    assert.ok(long.endsWith(".zip"));
    assert.equal(Array.from(long).length, MAX_FILE_NAME_LENGTH);
  });
});

describe("dedupeNames", () => {
  it("appends (2), (3) before the extension and keeps the order", () => {
    assert.deepEqual(dedupeNames(["a.pdf", "b.pdf", "a.pdf", "a.pdf"]), ["a.pdf", "b.pdf", "a (2).pdf", "a (3).pdf"]);
  });

  it("ignores case and handles names without an extension", () => {
    assert.deepEqual(dedupeNames(["Report", "report", "REPORT.PDF", "report.pdf"]), [
      "Report",
      "report (2)",
      "REPORT.PDF",
      "report (2).pdf",
    ]);
  });

  it("never produces a name that is already taken", () => {
    const result = dedupeNames(["a.pdf", "a (2).pdf", "a.pdf", "a (2).pdf"]);
    assert.equal(new Set(result.map((n) => n.toLowerCase())).size, result.length);
    assert.deepEqual(result, ["a.pdf", "a (2).pdf", "a (3).pdf", "a (2) (2).pdf"]);
  });

  it("returns an empty list for no names", () => {
    assert.deepEqual(dedupeNames([]), []);
  });
});

describe("indexCsv", () => {
  it("writes ordinal, number, date, subject, type with a BOM and CRLF", () => {
    const manifest = buildDossierManifest(dossier, [
      doc(2, "Quyết định, bổ nhiệm", { issued: "2026-03-01" }),
      doc(1, "Tờ trình", { arrival: "2026-02-01" }, { notation: null, type_name: null }),
      restricted(3),
    ]);
    const csv = indexCsv(manifest);
    assert.ok(csv.startsWith(BOM));
    const lines = csv.slice(1).split("\r\n");
    assert.deepEqual(lines, [
      "ordinal,number,date,subject,type",
      "1,,2026-02-01,Tờ trình,",
      '2,2/QĐ-ABC,2026-03-01,"Quyết định, bổ nhiệm",Quyết định',
      `3,,,${RESTRICTED_DOCUMENT_LABEL},`,
      "",
    ]);
  });

  it("neutralises formula-looking subjects", () => {
    const csv = indexCsv({
      documents: [{ ordinal: 1, notation: null, date: null, subject: "=HYPERLINK(1)", type: null }],
    });
    assert.ok(csv.includes("1,,,'=HYPERLINK(1),"));
  });

  it("writes only the header for an empty dossier", () => {
    assert.equal(indexCsv({ documents: [] }), `${BOM}ordinal,number,date,subject,type\r\n`);
  });
});

describe("planDossierExport", () => {
  const documents: DossierDocument[] = [
    restricted(1),
    doc(2, "Undated"),
    doc(3, "March", { issued: "2026-03-05" }),
    doc(4, "January arrival", { arrival: "2026-01-10" }),
    doc(5, "Same day, later in dossier", { issued: "2026-03-05" }),
    restricted(6),
  ];

  it("numbers readable documents exactly like the manifest", () => {
    const plan = planDossierExport(dossier, documents);
    const subjects = plan.items.map((item) => item.document.subject);
    assert.deepEqual(subjects, ["January arrival", "March", "Same day, later in dossier", "Undated"]);
    for (const item of plan.items) {
      const entry = plan.manifest.documents[item.ordinal - 1];
      assert.equal(entry.ordinal, item.ordinal);
      assert.equal(entry.subject, item.document.subject);
    }
    assert.equal(plan.manifest.documents.length, 6);
    assert.equal(plan.manifest.documents[4].subject, RESTRICTED_DOCUMENT_LABEL);
  });

  it("matches the manifest order for shuffled inputs", () => {
    const shuffled = [documents[4], documents[0], documents[2], documents[5], documents[3], documents[1]];
    const plan = planDossierExport(dossier, shuffled);
    const readableEntries = plan.manifest.documents.filter((e) => e.subject !== RESTRICTED_DOCUMENT_LABEL);
    assert.deepEqual(
      plan.items.map((item) => [item.ordinal, item.document.subject]),
      readableEntries.map((e) => [e.ordinal, e.subject])
    );
  });

  it("has no items when nothing is readable", () => {
    const plan = planDossierExport(dossier, [restricted(1), restricted(2)]);
    assert.deepEqual(plan.items, []);
    assert.equal(plan.manifest.documents.length, 2);
  });
});

describe("pickExportFile", () => {
  it("prefers the main file, else the first file", () => {
    assert.deepEqual(pickExportFile([{ kind: "attachment", id: "a" }, { kind: "main", id: "m" }]), { kind: "main", id: "m" });
    assert.deepEqual(pickExportFile([{ kind: "signed", id: "s" }, { kind: "attachment", id: "a" }]), { kind: "signed", id: "s" });
    assert.equal(pickExportFile([]), null);
  });
});

describe("skippedSummary", () => {
  it("lists at most `limit` files and counts the rest", () => {
    const skipped = Array.from({ length: 7 }, (_, i) => ({ ordinal: i + 1, name: `f${i + 1}.pdf`, reason: "Over 200 MB" }));
    const text = skippedSummary(skipped, 2);
    assert.equal(text, "001 f1.pdf: Over 200 MB\n002 f2.pdf: Over 200 MB\nand 5 more");
    assert.equal(skippedSummary([]), "");
  });

  it("uses a 200 MB limit", () => {
    assert.equal(MAX_EXPORT_FILE_BYTES, 209_715_200);
  });
});

describe("packDossierZip", () => {
  it("contains manifest.json, index.csv and the files with unique prefixed names", () => {
    const manifest = buildDossierManifest(dossier, [
      doc(1, "One", { issued: "2026-01-01" }),
      doc(2, "Two", { issued: "2026-01-02" }),
      restricted(3),
    ]);
    const zip = packDossierZip(
      manifest,
      [
        { ordinal: 2, name: "Quyết định.pdf", bytes: new Uint8Array([2, 2]) },
        { ordinal: 1, name: "a:b.pdf", bytes: new Uint8Array([1]) },
      ],
      "2026-10-30T00:00:00.000Z"
    );
    const files = unzipSync(zip);
    assert.deepEqual(Object.keys(files), ["manifest.json", "index.csv", "001_a b.pdf", "002_Quyết định.pdf"]);
    assert.deepEqual([...files["001_a b.pdf"]], [1]);
    assert.deepEqual([...files["002_Quyết định.pdf"]], [2, 2]);

    const json = JSON.parse(strFromU8(files["manifest.json"]));
    assert.equal(json.code, "01.HCNS");
    assert.equal(json.retention, "10 years");
    assert.equal(json.exported_at, "2026-10-30T00:00:00.000Z");
    assert.deepEqual(
      json.documents.map((d: { ordinal: number; file: string | null }) => [d.ordinal, d.file]),
      [
        [1, "001_a b.pdf"],
        [2, "002_Quyết định.pdf"],
        [3, null],
      ]
    );
    // TextDecoder drops the BOM, so check the raw bytes for it
    assert.deepEqual([...files["index.csv"].slice(0, 3)], [0xef, 0xbb, 0xbf]);
    assert.ok(strFromU8(files["index.csv"]).replace(BOM, "").startsWith("ordinal,number,date,subject,type"));
  });

  it("packs an empty dossier with only the two index files", () => {
    const zip = packDossierZip(buildDossierManifest(dossier, []), []);
    assert.deepEqual(Object.keys(unzipSync(zip)), ["manifest.json", "index.csv"]);
  });

  it("keeps document files apart from manifest.json and index.csv through the ordinal prefix", () => {
    const manifest = buildDossierManifest(dossier, [doc(1, "One", { issued: "2026-01-01" })]);
    const zip = packDossierZip(manifest, [{ ordinal: 1, name: "index.csv", bytes: new Uint8Array([9]) }]);
    assert.deepEqual(Object.keys(unzipSync(zip)), ["manifest.json", "index.csv", "001_index.csv"]);
  });
});

describe("manifestJson", () => {
  it("adds exported_at and a null file for entries without one", () => {
    const manifest = buildDossierManifest(dossier, [doc(1, "One")]);
    const json = JSON.parse(manifestJson(manifest, new Map(), "2026-01-01T00:00:00Z"));
    assert.equal(json.documents[0].file, null);
    assert.equal(json.title, "Hồ sơ hợp đồng");
  });
});
