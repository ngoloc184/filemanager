import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DOSSIER_STATUSES,
  DOSSIER_STATUS_LABELS,
  RESTRICTED_DOCUMENT_LABEL,
  addMonths,
  buildDossierManifest,
  retentionLabel,
  suggestDossierCode,
  transferDueDate,
  type DossierDocument,
} from "../documents/dossiers.ts";

describe("suggestDossierCode", () => {
  it("starts at 01 for a department with no dossiers", () => {
    assert.equal(suggestDossierCode([], "HCNS"), "01.HCNS");
  });

  it("continues after the highest number and does not refill gaps", () => {
    assert.equal(suggestDossierCode(["01.HCNS", "02.HCNS"], "HCNS"), "03.HCNS");
    assert.equal(suggestDossierCode(["01.HCNS", "04.HCNS"], "HCNS"), "05.HCNS");
  });

  it("ignores other departments and codes in another shape", () => {
    assert.equal(
      suggestDossierCode(["07.KT", "12.KT-2", "01.HCNS", "HCNS-03", "x.HCNS", "02.HCNS.1"], "HCNS"),
      "02.HCNS"
    );
    assert.equal(suggestDossierCode(["09.HCNS"], "KT"), "01.KT");
  });

  it("compares department codes without case or spaces", () => {
    assert.equal(suggestDossierCode([" 02.hcns "], " hcns "), "03.HCNS");
  });

  it("grows past two digits", () => {
    assert.equal(suggestDossierCode(["99.KT"], "KT"), "100.KT");
  });

  it("suggests a bare number without a department code", () => {
    assert.equal(suggestDossierCode(["01", "03", "05.KT"], ""), "04");
  });
});

describe("transferDueDate", () => {
  it("is one year after the end date", () => {
    assert.equal(transferDueDate("2026-10-30", false), "2027-10-30");
  });

  it("clamps 29 February to the 28th in the next year (like PostgreSQL)", () => {
    assert.equal(transferDueDate("2024-02-29", false), "2025-02-28");
    assert.equal(transferDueDate("2027-02-28", false), "2028-02-28");
  });

  it("is three months later for capital construction", () => {
    assert.equal(transferDueDate("2026-11-30", true), "2027-02-28");
    assert.equal(transferDueDate("2023-11-30", true), "2024-02-29");
    assert.equal(transferDueDate("2026-01-15", true), "2026-04-15");
  });

  it("rejects invalid dates", () => {
    assert.throws(() => transferDueDate("2026-02-30", false));
    assert.throws(() => transferDueDate("30/10/2026", false));
  });

  it("addMonths crosses year boundaries both ways", () => {
    assert.equal(addMonths("2026-12-31", 2), "2027-02-28");
    assert.equal(addMonths("2026-03-31", -1), "2026-02-28");
  });
});

describe("retention and status labels", () => {
  it("labels permanent, one year and many years", () => {
    assert.equal(retentionLabel({ years: null }), "Permanent (Vĩnh viễn)");
    assert.equal(retentionLabel({ years: 1 }), "1 year");
    assert.equal(retentionLabel({ years: 20 }), "20 years");
    assert.equal(retentionLabel(null), "Not set");
  });

  it("has a label for every dossier status", () => {
    for (const status of DOSSIER_STATUSES) assert.ok(DOSSIER_STATUS_LABELS[status]);
    assert.equal(DOSSIER_STATUS_LABELS.transferred, "Transferred to archive (Đã nộp lưu)");
  });
});

describe("buildDossierManifest", () => {
  const readable = (
    ordinal: number,
    subject: string,
    dates: { issued?: string | null; arrival?: string | null },
    notation: string | null = null
  ): DossierDocument => ({
    document_id: `doc-${ordinal}`,
    ordinal,
    subject,
    notation,
    arrival_number: null,
    direction: dates.arrival ? "incoming" : "outgoing",
    status: dates.arrival ? "completed" : "issued",
    issued_date: dates.issued ?? null,
    arrival_date: dates.arrival ?? null,
    type_name: "Công văn",
    readable: true,
  });

  it("lists documents in chronological order, numbered from 1", () => {
    const manifest = buildDossierManifest(
      {
        code: "01.HCNS",
        title: "Hồ sơ tuyển dụng",
        start_date: "2026-01-02",
        end_date: "2026-12-31",
        retention_code: "10",
        retention_years: 10,
      },
      [
        readable(1, "March", { issued: "2026-03-01" }, "05/TB-ABC"),
        readable(2, "January", { issued: "2026-01-10" }, "01/QĐ-ABC"),
        { document_id: "hidden", ordinal: 3, readable: false },
        readable(4, "No date", {}),
        readable(5, "Arrived in February", { arrival: "2026-02-04" }, "15/CV-XYZ"),
        readable(6, "Also March", { issued: "2026-03-01" }),
      ]
    );

    assert.equal(manifest.code, "01.HCNS");
    assert.equal(manifest.title, "Hồ sơ tuyển dụng");
    assert.equal(manifest.retention, "10 years");
    assert.equal(manifest.start_date, "2026-01-02");
    assert.equal(manifest.end_date, "2026-12-31");
    assert.deepEqual(
      manifest.documents.map((d) => [d.ordinal, d.subject, d.date]),
      [
        [1, "January", "2026-01-10"],
        [2, "Arrived in February", "2026-02-04"],
        [3, "March", "2026-03-01"],
        [4, "Also March", "2026-03-01"],
        [5, "No date", null],
        [6, RESTRICTED_DOCUMENT_LABEL, null],
      ]
    );
    assert.deepEqual(manifest.documents[0], {
      ordinal: 1,
      notation: "01/QĐ-ABC",
      date: "2026-01-10",
      subject: "January",
      type: "Công văn",
    });
    assert.deepEqual(manifest.documents[5], {
      ordinal: 6,
      notation: null,
      date: null,
      subject: RESTRICTED_DOCUMENT_LABEL,
      type: null,
    });
  });

  it("prefers the issued date over the arrival date", () => {
    const manifest = buildDossierManifest(
      { code: "02", title: "x", start_date: null, end_date: null },
      [readable(1, "Incoming", { issued: "2026-05-01", arrival: "2026-05-03" })]
    );
    assert.equal(manifest.documents[0].date, "2026-05-01");
    assert.equal(manifest.retention, "Not set");
  });

  it("labels a permanent retention code", () => {
    const manifest = buildDossierManifest(
      { code: "03", title: "x", start_date: null, end_date: null, retention_code: "VV", retention_years: null },
      []
    );
    assert.equal(manifest.retention, "Permanent (Vĩnh viễn)");
    assert.deepEqual(manifest.documents, []);
  });
});
