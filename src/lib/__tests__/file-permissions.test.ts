import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { can, roleOf, type ItemAction, type ItemRole } from "../file-permissions.ts";

const ACTIONS: ItemAction[] = [
  "download",
  "comment",
  "rename",
  "move",
  "edit_text",
  "upload_version",
  "restore_version",
  "edit_tags",
  "share",
  "delete",
  "toggle_public",
  "details",
];

// The full role × action matrix from the spec.
const ALLOWED: Record<ItemRole, ItemAction[]> = {
  viewer: ["download", "comment", "details"],
  editor: [
    "download",
    "comment",
    "details",
    "rename",
    "move",
    "edit_text",
    "upload_version",
    "restore_version",
    "edit_tags",
  ],
  admin: [
    "download",
    "comment",
    "details",
    "rename",
    "move",
    "edit_text",
    "upload_version",
    "restore_version",
    "edit_tags",
    "share",
    "delete",
  ],
  owner: ACTIONS,
};

describe("can", () => {
  for (const role of Object.keys(ALLOWED) as ItemRole[]) {
    it(`${role} may do exactly its actions`, () => {
      for (const action of ACTIONS) {
        assert.equal(
          can(role, action),
          ALLOWED[role].includes(action),
          `${role} / ${action}`
        );
      }
    });
  }

  it("no role allows nothing", () => {
    for (const action of ACTIONS) {
      assert.equal(can(null, action), false, `null / ${action}`);
      assert.equal(can(undefined, action), false, `undefined / ${action}`);
    }
  });

  it("only the owner toggles the public link", () => {
    assert.deepEqual(
      (["viewer", "editor", "admin", "owner"] as ItemRole[]).filter((role) =>
        can(role, "toggle_public")
      ),
      ["owner"]
    );
  });

  it("an unknown role string allows nothing", () => {
    assert.equal(can("superuser" as ItemRole, "download"), false);
  });
});

describe("roleOf", () => {
  const me = "user-1";

  it("is owner for my own item, whatever my_role says", () => {
    assert.equal(roleOf({ owner_id: me }, me), "owner");
    assert.equal(roleOf({ owner_id: me, my_role: null }, me), "owner");
    assert.equal(roleOf({ owner_id: me, my_role: "viewer" }, me), "owner");
  });

  it("uses my_role for someone else's item", () => {
    assert.equal(roleOf({ owner_id: "user-2", my_role: "editor" }, me), "editor");
    assert.equal(roleOf({ owner_id: "user-2", my_role: "admin" }, me), "admin");
    assert.equal(roleOf({ owner_id: "user-2", my_role: "viewer" }, me), "viewer");
  });

  it("is null for someone else's item without my_role", () => {
    assert.equal(roleOf({ owner_id: "user-2" }, me), null);
    assert.equal(roleOf({ owner_id: "user-2", my_role: null }, me), null);
  });
});
