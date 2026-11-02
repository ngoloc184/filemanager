import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_KEYWORDS,
  addKeywords,
  changedFields,
  cleanKeywords,
  emptyDocumentForm,
  findExternalOrgByName,
  foldText,
  formValuesFromDocument,
  isFormDirty,
  isFormValid,
  matchExternalOrgs,
  normalizeNotation,
  sortDocTypes,
  submitLabel,
  toIsoDay,
  toProfilePayload,
  validateDocumentForm,
  type DocumentFormValues,
} from "../documents/form.ts";

const TYPE = "type-cv";

function incomingValues(over: Partial<DocumentFormValues> = {}): DocumentFormValues {
  return emptyDocumentForm({
    docTypeId: TYPE,
    subject: "V/v báo cáo quý III",
    issuingOrgName: "UBND tỉnh Đồng Nai",
    notation: "123/UBND-VP",
    issuedDate: "2026-10-20",
    arrivalDate: "2026-10-22",
    ...over,
  });
}

describe("normalizeNotation", () => {
  it("trims, removes spaces around / and -, upper-cases", () => {
    assert.equal(normalizeNotation(" 123 / ubnd - vp "), "123/UBND-VP");
    assert.equal(normalizeNotation("45/qđ-ubnd"), "45/QĐ-UBND");
    assert.equal(normalizeNotation("12 /  BC -  STC"), "12/BC-STC");
  });
  it("collapses other whitespace and keeps Đ", () => {
    assert.equal(normalizeNotation("số  01   đặc biệt"), "SỐ 01 ĐẶC BIỆT");
    assert.equal(normalizeNotation("đ"), "Đ");
  });
  it("handles empty input", () => {
    assert.equal(normalizeNotation(""), "");
    assert.equal(normalizeNotation("   "), "");
    assert.equal(normalizeNotation(null), "");
  });
});

describe("toIsoDay", () => {
  it("accepts yyyy-mm-dd and dd/mm/yyyy", () => {
    assert.equal(toIsoDay("2026-10-30"), "2026-10-30");
    assert.equal(toIsoDay("5/1/2026"), "2026-01-05");
    assert.equal(toIsoDay(" 30/10/2026 "), "2026-10-30");
  });
  it("returns '' for empty and null for invalid", () => {
    assert.equal(toIsoDay(""), "");
    assert.equal(toIsoDay(undefined), "");
    assert.equal(toIsoDay("2026-02-30"), null);
    assert.equal(toIsoDay("31/04/2026"), null);
    assert.equal(toIsoDay("yesterday"), null);
  });
});

describe("keywords", () => {
  it("cleanKeywords trims, drops blanks and case-insensitive duplicates", () => {
    assert.deepEqual(cleanKeywords([" Tài chính ", "", "tài chính", "Báo  cáo", "báo cáo"]), [
      "Tài chính",
      "Báo cáo",
    ]);
  });
  it("addKeywords splits on commas and caps at 10", () => {
    assert.deepEqual(addKeywords(["a"], "b, c ,a,,"), ["a", "b", "c"]);
    const many = addKeywords([], Array.from({ length: 15 }, (_, i) => `k${i}`).join(","));
    assert.equal(many.length, MAX_KEYWORDS);
    assert.equal(many[9], "k9");
  });
});

describe("validateDocumentForm", () => {
  it("accepts a complete incoming form with a main file", () => {
    const errors = validateDocumentForm(incomingValues(), "incoming", { registerNow: true, hasMainFile: true });
    assert.deepEqual(errors, {});
    assert.ok(isFormValid(errors));
  });

  it("requires subject and type", () => {
    const errors = validateDocumentForm(emptyDocumentForm({ subject: "   " }), "outgoing");
    assert.equal(errors.subject, "Enter the subject (trích yếu)");
    assert.equal(errors.docTypeId, "Choose the document type");
    assert.ok(!isFormValid(errors));
  });

  it("limits the subject to 500 characters", () => {
    const ok = validateDocumentForm(emptyDocumentForm({ docTypeId: TYPE, subject: "x".repeat(500) }), "outgoing");
    assert.equal(ok.subject, undefined);
    const long = validateDocumentForm(emptyDocumentForm({ docTypeId: TYPE, subject: "x".repeat(501) }), "outgoing");
    assert.match(long.subject ?? "", /at most 500/);
  });

  it("register now needs issuing org, notation and a main file", () => {
    const values = incomingValues({ issuingOrgName: " ", notation: "" });
    const errors = validateDocumentForm(values, "incoming", { registerNow: true, hasMainFile: false });
    assert.equal(errors.issuingOrgName, "Enter the issuing organisation");
    assert.match(errors.notation ?? "", /number and notation/);
    assert.equal(errors.mainFile, "Attach the main document");
  });

  it("a draft without register now does not need sender details or a file", () => {
    const values = incomingValues({ issuingOrgName: "", notation: "" });
    assert.deepEqual(validateDocumentForm(values, "incoming", { registerNow: false }), {});
  });

  it("outgoing ignores sender fields and the main file", () => {
    const values = emptyDocumentForm({ docTypeId: TYPE, subject: "Quyết định", notation: "x".repeat(200) });
    assert.deepEqual(validateDocumentForm(values, "outgoing", { registerNow: true, hasMainFile: false }), {});
  });

  it("due date may not be before the document date", () => {
    const errors = validateDocumentForm(incomingValues({ dueDate: "2026-10-19" }), "incoming");
    assert.equal(errors.dueDate, "The due date cannot be before the document date");
    const same = validateDocumentForm(incomingValues({ dueDate: "2026-10-20" }), "incoming");
    assert.equal(same.dueDate, undefined);
  });

  it("arrival date may not be before the document date", () => {
    const errors = validateDocumentForm(incomingValues({ arrivalDate: "2026-10-01" }), "incoming");
    assert.match(errors.arrivalDate ?? "", /cannot be before/);
  });

  it("reports invalid dates and page counts", () => {
    const errors = validateDocumentForm(
      incomingValues({ dueDate: "2026-13-01", issuedDate: "bad", pageCount: "2.5" }),
      "incoming"
    );
    assert.equal(errors.dueDate, "Enter a valid date");
    assert.equal(errors.issuedDate, "Enter a valid date");
    assert.match(errors.pageCount ?? "", /whole number/);
    assert.match(validateDocumentForm(incomingValues({ pageCount: "0" }), "incoming").pageCount ?? "", /whole/);
    assert.equal(validateDocumentForm(incomingValues({ pageCount: " 12 " }), "incoming").pageCount, undefined);
  });

  it("limits keywords to 10, each at most 50 characters", () => {
    const eleven = Array.from({ length: 11 }, (_, i) => `k${i}`);
    assert.equal(
      validateDocumentForm(incomingValues({ keywords: eleven }), "incoming").keywords,
      "At most 10 keywords"
    );
    assert.match(
      validateDocumentForm(incomingValues({ keywords: ["x".repeat(51)] }), "incoming").keywords ?? "",
      /at most 50/
    );
    // duplicates do not count twice
    const dupes = [...Array.from({ length: 10 }, (_, i) => `k${i}`), "K0"];
    assert.equal(validateDocumentForm(incomingValues({ keywords: dupes }), "incoming").keywords, undefined);
  });

  it("checks the notation length after normalising", () => {
    const errors = validateDocumentForm(incomingValues({ notation: "a".repeat(101) }), "incoming");
    assert.match(errors.notation ?? "", /at most 100/);
  });
});

describe("toProfilePayload", () => {
  it("builds the incoming payload: trimmed, normalised, empties left out", () => {
    const payload = toProfilePayload(
      incomingValues({
        subject: "  V/v báo cáo  ",
        notation: " 123 / ubnd - vp ",
        issuedDate: "20/10/2026",
        keywords: [" Tài chính", "tài chính", "Quý III"],
        description: "   ",
        signerName: " Nguyễn Văn A ",
        pageCount: "3",
        draftingDepartmentId: "dept-1",
        externalOrgId: "ext-1",
      }),
      "incoming"
    );
    assert.deepEqual(payload, {
      subject: "V/v báo cáo",
      doc_type_id: TYPE,
      urgency: "normal",
      confidentiality: "normal",
      keywords: ["Tài chính", "Quý III"],
      issuing_org_name: "UBND tỉnh Đồng Nai",
      external_org_id: "ext-1",
      notation: "123/UBND-VP",
      issued_date: "2026-10-20",
      arrival_date: "2026-10-22",
      signer_name: "Nguyễn Văn A",
      page_count: 3,
    });
  });

  it("outgoing keeps the drafting department and leaves sender fields out", () => {
    const payload = toProfilePayload(
      emptyDocumentForm({
        docTypeId: TYPE,
        fieldId: "field-1",
        subject: "Quyết định",
        urgency: "khan",
        confidentiality: "internal",
        dueDate: "2026-11-05",
        draftingDepartmentId: "dept-1",
        notation: "should not appear",
        issuingOrgName: "nor this",
        arrivalDate: "2026-10-22",
      }),
      "outgoing"
    );
    assert.deepEqual(payload, {
      subject: "Quyết định",
      doc_type_id: TYPE,
      field_id: "field-1",
      urgency: "khan",
      confidentiality: "internal",
      due_date: "2026-11-05",
      drafting_department_id: "dept-1",
    });
  });

  it("leaves out unparseable dates and page counts", () => {
    const payload = toProfilePayload(incomingValues({ dueDate: "nope", pageCount: "x" }), "incoming");
    assert.equal("due_date" in payload, false);
    assert.equal("page_count" in payload, false);
  });
});

describe("changedFields", () => {
  const doc = {
    doc_type_id: TYPE,
    field_id: "field-1",
    subject: "V/v báo cáo",
    urgency: "normal" as const,
    confidentiality: "normal" as const,
    due_date: "2026-11-05",
    keywords: ["Tài chính"],
    description: "Ghi chú",
    drafting_department_id: null,
    issuing_org_name: "UBND tỉnh Đồng Nai",
    external_org_id: "ext-1",
    notation: "123/UBND-VP",
    issued_date: "2026-10-20",
    arrival_date: "2026-10-22",
    signer_name: null,
    signer_position: null,
    page_count: 2,
  };

  it("returns nothing when nothing changed", () => {
    const values = formValuesFromDocument(doc);
    const before = toProfilePayload(values, "incoming");
    assert.deepEqual(changedFields(before, toProfilePayload({ ...values }, "incoming")), {});
    assert.equal(isFormDirty(values, { ...values, keywords: [...values.keywords] }), false);
  });

  it("returns only the changed keys", () => {
    const values = formValuesFromDocument(doc);
    const before = toProfilePayload(values, "incoming");
    const after = toProfilePayload({ ...values, subject: "V/v báo cáo quý IV", urgency: "khan" }, "incoming");
    assert.deepEqual(changedFields(before, after), { subject: "V/v báo cáo quý IV", urgency: "khan" });
  });

  it("sends null for cleared fields and [] for cleared keywords", () => {
    const values = formValuesFromDocument(doc);
    const before = toProfilePayload(values, "incoming");
    const after = toProfilePayload(
      { ...values, fieldId: "", dueDate: "", description: "", keywords: [], externalOrgId: "", pageCount: "" },
      "incoming"
    );
    assert.deepEqual(changedFields(before, after), {
      field_id: null,
      due_date: null,
      description: null,
      keywords: [],
      external_org_id: null,
      page_count: null,
    });
  });

  it("detects keyword order and content changes", () => {
    assert.deepEqual(changedFields({ keywords: ["a", "b"] }, { keywords: ["b", "a"] }), { keywords: ["b", "a"] });
    assert.deepEqual(changedFields({}, { keywords: ["a"] }), { keywords: ["a"] });
  });

  it("formValuesFromDocument maps nulls to empty strings and dates to days", () => {
    const values = formValuesFromDocument({ ...doc, due_date: "2026-11-05T00:00:00+07:00", page_count: null });
    assert.equal(values.dueDate, "2026-11-05");
    assert.equal(values.pageCount, "");
    assert.equal(values.draftingDepartmentId, "");
    assert.equal(values.signerName, "");
  });
});

describe("lookups", () => {
  const types = [
    { id: "qd", name: "Quyết định", is_cong_van: false, active: true, sort_order: 1 },
    { id: "bc", name: "Báo cáo", is_cong_van: false, active: true, sort_order: 1 },
    { id: "cv", name: "Công văn", is_cong_van: true, active: true, sort_order: 9 },
    { id: "old", name: "Cũ", is_cong_van: false, active: false, sort_order: 0 },
  ];

  it("sortDocTypes puts công văn first and hides inactive types", () => {
    assert.deepEqual(
      sortDocTypes(types).map((t) => t.id),
      ["cv", "bc", "qd"]
    );
    assert.deepEqual(
      sortDocTypes(types, "old").map((t) => t.id),
      ["cv", "old", "bc", "qd"]
    );
  });

  const orgs = [
    { name: "Sở Tài chính", code: "STC" },
    { name: "UBND tỉnh Đồng Nai", code: "UBND-DN" },
    { name: "Bộ Tài chính", code: null },
  ];

  it("foldText removes accents and đ", () => {
    assert.equal(foldText("  Ủy ban  Đồng Nai "), "uy ban dong nai");
  });

  it("matchExternalOrgs ignores accents; prefix matches first", () => {
    assert.deepEqual(
      matchExternalOrgs(orgs, "tai chinh").map((o) => o.name),
      ["Bộ Tài chính", "Sở Tài chính"]
    );
    assert.deepEqual(
      matchExternalOrgs(orgs, "so").map((o) => o.name),
      ["Sở Tài chính"]
    );
    assert.deepEqual(
      matchExternalOrgs(orgs, "dong nai").map((o) => o.name),
      ["UBND tỉnh Đồng Nai"]
    );
    assert.deepEqual(
      matchExternalOrgs(orgs, "ubnd-dn").map((o) => o.name),
      ["UBND tỉnh Đồng Nai"]
    );
    assert.equal(matchExternalOrgs(orgs, "", 2).length, 2);
    assert.deepEqual(matchExternalOrgs(orgs, "zzz"), []);
  });

  it("findExternalOrgByName matches case-insensitively but keeps accents", () => {
    assert.equal(findExternalOrgByName(orgs, "  sở tài  chính ")?.name, "Sở Tài chính");
    assert.equal(findExternalOrgByName(orgs, "So Tai chinh"), null);
    assert.equal(findExternalOrgByName(orgs, ""), null);
  });
});

describe("submitLabel", () => {
  it("names the primary button", () => {
    assert.equal(submitLabel("create", "incoming", true), "Save and register");
    assert.equal(submitLabel("create", "incoming", false), "Save draft");
    assert.equal(submitLabel("create", "outgoing", true), "Save draft");
    assert.equal(submitLabel("create", "internal", false), "Save draft");
    assert.equal(submitLabel("edit", "incoming", true), "Save changes");
  });
});
