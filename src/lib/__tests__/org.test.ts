import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ORG_ROLES,
  ROLE_LABELS,
  buildDepartmentTree,
  flattenTree,
  hasRole,
  isOrgRole,
  isValidDepartmentCode,
  isValidOrgCode,
  memberLabel,
  normalizeCode,
  roleLabels,
  type DepartmentRow,
} from "../org.ts";

const dept = (id: string, parent_id: string | null, name: string, sort_order = 0): DepartmentRow => ({
  id,
  parent_id,
  name,
  sort_order,
});

const shape = (rows: DepartmentRow[]) =>
  flattenTree(buildDepartmentTree(rows)).map((d) => `${"-".repeat(d.depth)}${d.id}`);

describe("codes", () => {
  it("normalizes codes: upper-case, trimmed, no spaces", () => {
    assert.equal(normalizeCode("  abc "), "ABC");
    assert.equal(normalizeCode("v p\tub"), "VPUB");
    assert.equal(normalizeCode("đhqg"), "ĐHQG");
  });

  it("accepts company codes of 2-15 upper-case letters, Đ or digits", () => {
    for (const ok of ["AB", "ABC", "VNPT", "ĐHQG", "UBND2026", "A".repeat(15)]) {
      assert.equal(isValidOrgCode(ok), true, ok);
    }
    for (const bad of ["", "A", "abc", "AB-C", "AB C", "A".repeat(16), "ÂB"]) {
      assert.equal(isValidOrgCode(bad), false, bad);
    }
  });

  it("accepts department codes of 1-20 upper-case letters, Đ, digits or dashes", () => {
    for (const ok of ["P", "HR", "IT-DEV", "P-TCHC", "ĐT", "X".repeat(20)]) {
      assert.equal(isValidDepartmentCode(ok), true, ok);
    }
    for (const bad of ["", "hr", "IT DEV", "IT_DEV", "X".repeat(21)]) {
      assert.equal(isValidDepartmentCode(bad), false, bad);
    }
  });

  it("normalized input passes validation", () => {
    assert.equal(isValidOrgCode(normalizeCode(" ab c ")), true);
    assert.equal(isValidDepartmentCode(normalizeCode("it - dev")), true);
  });
});

describe("roles and labels", () => {
  it("has a label for every role, with the Vietnamese term", () => {
    assert.deepEqual(Object.keys(ROLE_LABELS).sort(), [...ORG_ROLES].sort());
    assert.equal(ROLE_LABELS.org_admin, "Admin");
    assert.equal(ROLE_LABELS.clerk, "Records clerk (Văn thư)");
    assert.equal(ROLE_LABELS.leader, "Leader (Lãnh đạo)");
    assert.equal(ROLE_LABELS.dept_head, "Department head (Trưởng phòng)");
    assert.equal(ROLE_LABELS.staff, "Staff (Chuyên viên)");
  });

  it("hasRole checks the roles list and tolerates missing data", () => {
    assert.equal(hasRole({ roles: ["clerk", "staff"] }, "clerk"), true);
    assert.equal(hasRole({ roles: ["staff"] }, "org_admin"), false);
    assert.equal(hasRole({ roles: null }, "staff"), false);
    assert.equal(hasRole(null, "staff"), false);
    assert.equal(hasRole(undefined, "staff"), false);
  });

  it("isOrgRole recognizes only the five roles", () => {
    assert.equal(isOrgRole("leader"), true);
    assert.equal(isOrgRole("admin"), false);
    assert.equal(isOrgRole(null), false);
  });

  it("roleLabels lists labels in the canonical order", () => {
    assert.deepEqual(roleLabels(["staff", "org_admin", "bogus"]), ["Admin", "Staff (Chuyên viên)"]);
    assert.deepEqual(roleLabels(null), []);
  });

  it("memberLabel prefers the display name, then the e-mail", () => {
    assert.equal(memberLabel({ display_name: "Bob Trần", email: "bob@example.com" }), "Bob Trần");
    assert.equal(memberLabel({ display_name: "  ", email: "bob@example.com" }), "bob@example.com");
    assert.equal(memberLabel({ display_name: null, email: "bob@example.com" }), "bob@example.com");
    assert.equal(memberLabel({}), "");
  });
});

describe("department tree", () => {
  it("nests children and sorts by sort_order, then name", () => {
    const rows = [
      dept("hr", null, "Human resources", 2),
      dept("it", null, "IT", 1),
      dept("web", "it", "Web", 0),
      dept("app", "it", "App", 0),
      dept("ops", "it", "Ops", -1),
      dept("acc", null, "Accounting", 2),
    ];
    assert.deepEqual(shape(rows), ["it", "-ops", "-app", "-web", "acc", "hr"]);
  });

  it("sorts Vietnamese names naturally", () => {
    const rows = [dept("b", null, "Ban Đối ngoại"), dept("a", null, "Ban Điều hành"), dept("c", null, "Ban Dự án")];
    assert.deepEqual(shape(rows), ["c", "a", "b"]);
  });

  it("treats departments with a missing parent as roots", () => {
    const rows = [dept("x", "gone", "Orphan"), dept("y", null, "Main"), dept("z", "x", "Child")];
    assert.deepEqual(shape(rows), ["y", "x", "-z"]);
  });

  it("is cycle-safe: every row appears exactly once", () => {
    const rows = [
      dept("a", "c", "A"),
      dept("b", "a", "B"),
      dept("c", "b", "C"),
      dept("d", "b", "D"),
      dept("self", "self", "Self"),
      dept("root", null, "Root"),
    ];
    const flat = flattenTree(buildDepartmentTree(rows));
    assert.deepEqual(flat.map((d) => d.id).sort(), ["a", "b", "c", "d", "root", "self"]);
    // the cycle is cut at its first member (A), which becomes a root
    assert.deepEqual(shape(rows), ["a", "-b", "--c", "--d", "root", "self"]);
  });

  it("flattens with depth and keeps the row fields", () => {
    const rows = [
      { ...dept("p", null, "Parent"), code: "P" },
      { ...dept("k", "p", "Kid"), code: "K" },
    ];
    const flat = flattenTree(buildDepartmentTree(rows));
    assert.deepEqual(
      flat.map((d) => [d.id, d.code, d.depth]),
      [
        ["p", "P", 0],
        ["k", "K", 1],
      ]
    );
    assert.equal("children" in flat[0], false);
  });

  it("handles an empty list and does not mutate its input", () => {
    assert.deepEqual(buildDepartmentTree([]), []);
    const rows = [dept("a", null, "A")];
    buildDepartmentTree(rows);
    assert.equal("children" in rows[0], false);
  });
});
