import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildDepartmentTree, type DepartmentRow } from "../org.ts";
import {
  FALLBACK_TIME_ZONES,
  dayYear,
  descendantIds,
  isoDay,
  removesOwnAdmin,
  timeZoneOptions,
  toggleRole,
  validateDepartmentForm,
  validateInviteForm,
  validateOrgForm,
} from "../org-forms.ts";

const dept = (id: string, parent_id: string | null): DepartmentRow => ({
  id,
  parent_id,
  name: id,
  sort_order: 0,
});

describe("validateInviteForm", () => {
  it("accepts an email with at least one role", () => {
    assert.equal(validateInviteForm({ email: " a@b.co ", roles: ["staff"] }), null);
  });

  it("rejects a missing or malformed email first", () => {
    for (const email of ["", "   ", "a@b", "a b@c.d", "@b.co", "a@.co x"]) {
      assert.equal(validateInviteForm({ email, roles: ["staff"] }), "Enter a valid email address", email);
    }
    assert.equal(validateInviteForm({ email: "nope", roles: [] }), "Enter a valid email address");
  });

  it("needs a role", () => {
    assert.equal(validateInviteForm({ email: "a@b.co", roles: [] }), "Pick at least one role");
  });
});

describe("validateDepartmentForm", () => {
  it("accepts a name and a valid code", () => {
    assert.equal(validateDepartmentForm({ name: "Phòng Hành chính", code: "HC-1" }), null);
    assert.equal(validateDepartmentForm({ name: "Kế toán", code: "KT" }), null);
  });

  it("needs a name of at most 200 characters", () => {
    assert.equal(validateDepartmentForm({ name: "  ", code: "HC" }), "Enter a department name");
    assert.match(validateDepartmentForm({ name: "x".repeat(201), code: "HC" }) ?? "", /200/);
  });

  it("uses the department code rule (upper-case letters, digits, dashes, 1-20)", () => {
    const msg = "Department code must be 1 to 20 letters, digits or dashes";
    assert.equal(validateDepartmentForm({ name: "A", code: "" }), msg);
    assert.equal(validateDepartmentForm({ name: "A", code: "hc" }), msg);
    assert.equal(validateDepartmentForm({ name: "A", code: "H C" }), msg);
    assert.equal(validateDepartmentForm({ name: "A", code: "A".repeat(21) }), msg);
    assert.equal(validateDepartmentForm({ name: "A", code: "ĐT" }), null);
  });
});

describe("validateOrgForm", () => {
  it("checks the name length and the company code", () => {
    assert.equal(validateOrgForm({ name: "Công ty ABC", code: "ABC" }), null);
    assert.match(validateOrgForm({ name: "A", code: "ABC" }) ?? "", /2 to 200/);
    assert.match(validateOrgForm({ name: "ACME", code: "A" }) ?? "", /code/);
    assert.match(validateOrgForm({ name: "ACME", code: "A-B" }) ?? "", /code/);
  });
});

describe("descendantIds", () => {
  const tree = buildDepartmentTree([
    dept("root", null),
    dept("a", "root"),
    dept("a1", "a"),
    dept("a2", "a"),
    dept("a1x", "a1"),
    dept("b", "root"),
    dept("other", null),
  ]);

  it("lists the whole subtree below the department, not the department itself", () => {
    assert.deepEqual(descendantIds(tree, "a").sort(), ["a1", "a1x", "a2"]);
    assert.deepEqual(descendantIds(tree, "root").sort(), ["a", "a1", "a1x", "a2", "b"]);
  });

  it("is empty for a leaf or an unknown id", () => {
    assert.deepEqual(descendantIds(tree, "a1x"), []);
    assert.deepEqual(descendantIds(tree, "missing"), []);
    assert.deepEqual(descendantIds([], "a"), []);
  });
});

describe("toggleRole", () => {
  it("adds and removes roles in the canonical order", () => {
    assert.deepEqual(toggleRole(["staff"], "org_admin", true), ["org_admin", "staff"]);
    assert.deepEqual(toggleRole(["org_admin", "staff"], "staff", false), ["org_admin"]);
    assert.deepEqual(toggleRole(["clerk"], "clerk", true), ["clerk"]);
    assert.deepEqual(toggleRole([], "leader", false), []);
  });
});

describe("removesOwnAdmin", () => {
  it("is true only when an admin drops their own admin role", () => {
    assert.equal(removesOwnAdmin(true, ["org_admin", "leader"], ["leader"]), true);
    assert.equal(removesOwnAdmin(true, ["org_admin"], ["org_admin", "staff"]), false);
    assert.equal(removesOwnAdmin(false, ["org_admin"], ["staff"]), false);
    assert.equal(removesOwnAdmin(true, ["staff"], ["clerk"]), false);
  });
});

describe("timeZoneOptions", () => {
  it("falls back to a fixed list and keeps the current zone", () => {
    const list = timeZoneOptions(null, "Asia/Ho_Chi_Minh");
    assert.equal(list.length, FALLBACK_TIME_ZONES.length);
    assert.ok(list.includes("Asia/Ho_Chi_Minh"));
    assert.ok(timeZoneOptions([], "Etc/GMT-7").includes("Etc/GMT-7"));
  });

  it("adds a missing current zone, sorted and without duplicates", () => {
    assert.deepEqual(timeZoneOptions(["UTC", "Asia/Tokyo"], "Asia/Tokyo"), ["Asia/Tokyo", "UTC"]);
    assert.deepEqual(timeZoneOptions(["UTC"], "Asia/Ho_Chi_Minh"), ["Asia/Ho_Chi_Minh", "UTC"]);
  });
});

describe("days", () => {
  it("formats the local calendar day", () => {
    assert.equal(isoDay(new Date(2026, 0, 5, 23, 59)), "2026-01-05");
    assert.equal(isoDay(new Date(2026, 11, 31, 0, 0)), "2026-12-31");
  });

  it("reads the year of a YYYY-MM-DD day", () => {
    assert.equal(dayYear("2027-04-30"), 2027);
    assert.ok(Number.isNaN(dayYear("30/04/2027")));
  });
});
