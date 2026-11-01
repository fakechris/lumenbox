"""
The walk in box-ax, on a fake tree: what it reads, where it stops, what it says it left
(INV-1481). Runs without AT-SPI — the module is imported, not executed, so the bus is never
touched — with `python3 docker/box/test_box_ax.py`; src/cua/box-ax.test.ts runs it under npm test.
"""

import importlib.machinery
import importlib.util
import os
import sys
import types
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))


def load_box_ax():
    # A stub `gi` so the import line in the module never looks for the real bindings.
    sys.modules.setdefault("gi", types.ModuleType("gi"))
    loader = importlib.machinery.SourceFileLoader("box_ax", os.path.join(HERE, "box-ax"))
    spec = importlib.util.spec_from_loader("box_ax", loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


box_ax = load_box_ax()


class Node:
    """Enough of an Atspi.Accessible for the walk: role, name, states, children, a rectangle."""

    def __init__(self, role, name="", children=(), showing=True, rect=(0, 0, 10, 10), enabled=True):
        self.role, self.name, self.children, self.showing, self.rect, self.enabled = role, name, list(children), showing, rect, enabled
        self.app = types.SimpleNamespace(bus_name=":1.7")
        self.path = "/org/a11y/%s/%s" % (role.replace(" ", ""), name or id(self))

    def get_role_name(self):
        return self.role

    def get_name(self):
        return self.name

    def get_child_count(self):
        return len(self.children)

    def get_child_at_index(self, index):
        return self.children[index]

    def get_state_set(self):
        names = {"VISIBLE"} | ({"SHOWING"} if self.showing else set()) | ({"ENABLED", "SENSITIVE"} if self.enabled else set())
        return types.SimpleNamespace(contains=lambda state: state in names)

    def get_component_iface(self):
        rect = self.rect
        return types.SimpleNamespace(get_extents=lambda _coord: types.SimpleNamespace(x=rect[0], y=rect[1], width=rect[2], height=rect[3]))

    def get_interfaces(self):
        return []


class FakeStateType:
    """State names resolve to themselves, so the stub state set can answer by name."""

    def __getattr__(self, name):
        return name


def button(name):
    return Node("push button", name)


class WalkTest(unittest.TestCase):
    def setUp(self):
        box_ax.Atspi = types.SimpleNamespace(StateType=FakeStateType(), CoordType=types.SimpleNamespace(SCREEN=0))
        box_ax.LIMIT = 150

    def test_reads_top_to_bottom_and_names_refs_with_the_prefix(self):
        window = Node("frame", "Files", [Node("panel", "", [button("Back"), button("Forward")]), button("Close")])
        elements, cut = box_ax.walk(window, ref_prefix="d2")
        self.assertEqual([e["name"] for e in elements], ["Back", "Forward", "Close"])
        self.assertEqual([e["ref"] for e in elements], ["d21", "d22", "d23"])
        self.assertEqual(cut, [], "everything was read")

    def test_over_the_limit_the_unread_containers_are_named_with_their_paths(self):
        box_ax.LIMIT = 2
        rows = Node("table", "Rows", [Node("table cell", "row %d" % n) for n in range(5)])
        toolbar = Node("tool bar", "Tools", [button("New"), button("Open")])
        window = Node("frame", "Files", [toolbar, rows, button("Close")])
        elements, cut = box_ax.walk(window)
        self.assertEqual([e["name"] for e in elements], ["New", "Open"], "the first two controls, then it stops")
        self.assertEqual([(c["name"], c["children_count"], c["path"]) for c in cut], [("Rows", 5, "1")], "the table was never entered; its path leads back to it")
        self.assertNotIn("Close", [e["name"] for e in elements])

    def test_a_root_path_reads_one_subtree_alone(self):
        rows = Node("table", "Rows", [Node("table cell", "row %d" % n) for n in range(3)])
        window = Node("frame", "Files", [Node("tool bar", "Tools", [button("New")]), rows])
        root = box_ax.descend(window, "1")
        self.assertIs(root, rows)
        elements, cut = box_ax.walk(root, root_path="1", ref_prefix="b")
        self.assertEqual([e["name"] for e in elements], ["row 0", "row 1", "row 2"])
        self.assertEqual([e["ref"] for e in elements], ["b1", "b2", "b3"])
        self.assertIsNone(box_ax.descend(window, "1/9"), "a path past the children is nowhere")
        self.assertIsNone(box_ax.descend(window, "7"))

    def test_unnamed_wrappers_do_not_spend_the_node_budget(self):
        box_ax.NODE_BUDGET = 3
        # Chromium: button inside section inside group inside panel, none of them named.
        deep = Node("panel", "", [Node("group", "", [Node("section", "", [button("Submit")])])])
        window = Node("frame", "Page", [deep])
        elements, cut = box_ax.walk(window)
        self.assertEqual([e["name"] for e in elements], ["Submit"], "four wrappers cost nothing; the button is reached")
        named = Node("panel", "Sidebar", [Node("panel", "Nav", [Node("panel", "List", [button("Submit")])])])
        elements, cut = box_ax.walk(Node("frame", "Page", [named]))
        self.assertEqual(elements, [], "named panels are real structure and count")
        self.assertEqual(cut[0]["name"], "List")
        box_ax.NODE_BUDGET = 5000

    def test_a_hidden_or_disabled_control_is_read_as_it_is(self):
        window = Node("frame", "W", [Node("push button", "Ghost", showing=False), Node("push button", "Off", enabled=False)])
        elements, _cut = box_ax.walk(window)
        self.assertEqual([(e["name"], e["states"]) for e in elements], [("Off", ["disabled"])])


if __name__ == "__main__":
    unittest.main()
