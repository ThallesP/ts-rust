//! PORT: not in Effect-TS/tsgo. Each Go rule walks the whole source file
//! with `ForEachChild`, so a file is walked about 20 to 50 times (one walk
//! per enabled rule, plus the type parser's per-file walks). `NodeOrder`
//! keeps the nodes of one file in that walk's order, built with one walk,
//! and the rules read it in their own turn (`TypeParser::node_order`).
//!
//! A rule that reads it still runs alone, in `rules::ALL` order, and visits
//! the same nodes in the same order as its Go walk. So its checker and type
//! parser queries keep effect-tsgo's order (effperf2 item 1; effperf0 F4
//! interleaved the rules and was not taken).

use crate::effect::typeparser::TypeParser;
use crate::prelude::*;

/// The nodes of one subtree in Go `ForEachChild` pre-order (no JSDoc): the
/// root at index 0, then each child's subtree in child order. `end[i]` is
/// the index after the subtree of node `i`.
pub struct NodeOrder {
    nodes: Vec<Node>,
    end: Vec<u32>,
}

/// What `NodeOrder::walk_preorder` does after a node. No Go walk that
/// uses it ends early (each Go visitor returns false), so there is no stop.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Walk {
    /// Visit the node's children next (Go: the walk calls `ForEachChild`).
    Descend,
    /// Do not visit the node's children (Go: the walk returns first).
    SkipChildren,
}

impl NodeOrder {
    /// The order of `root` and its subtree, from one `for_each_child` walk.
    /// A nil child is not in the order.
    #[must_use]
    pub fn build(root: Node) -> Self {
        fn visit(n: Node, nodes: &mut Vec<Node>, end: &mut Vec<u32>) {
            let i = nodes.len();
            nodes.push(n);
            end.push(0);
            n.for_each_child(|child| {
                // Go `visit` (ast.go:31) skips a nil child field, but
                // `visitNodes` (ast.go:38) passes a nil list entry, and each
                // Go rule walk skips it (`if node == nil`, for example
                // schema_number.go:46 and promise_in_effect_success.go:39).
                // A parsed file has no nil list entry, so this changes no
                // output.
                if child.is_some() {
                    visit(child, nodes, end);
                }
                false
            });
            end[i] = u32::try_from(nodes.len()).expect("node count fits u32");
        }
        let mut order = NodeOrder {
            nodes: Vec::new(),
            end: Vec::new(),
        };
        if root.is_some() {
            visit(root, &mut order.nodes, &mut order.end);
        }
        order
    }

    /// The root node (Node::NIL for an empty order).
    #[must_use]
    pub fn root(&self) -> Node {
        self.nodes.first().copied().unwrap_or(Node::NIL)
    }

    /// Every node in pre-order, the root first.
    #[must_use]
    pub fn nodes(&self) -> &[Node] {
        &self.nodes
    }

    /// The node at index `i`.
    #[must_use]
    pub fn node(&self, i: u32) -> Node {
        self.nodes[i as usize]
    }

    /// The indexes of the children of node `i`, in `for_each_child` order.
    pub fn children(&self, i: u32) -> impl Iterator<Item = u32> + '_ {
        let end = self.end[i as usize];
        let mut next = i + 1;
        std::iter::from_fn(move || {
            (next < end).then(|| {
                let child = next;
                next = self.end[child as usize];
                child
            })
        })
    }

    /// Go's recursive rule walk from the root: `f` sees each node in
    /// pre-order and says whether to visit its children.
    pub fn walk_preorder(&self, mut f: impl FnMut(Node) -> Walk) {
        let mut i = 0;
        while i < self.nodes.len() {
            match f(self.nodes[i]) {
                Walk::Descend => i += 1,
                Walk::SkipChildren => i = self.end[i] as usize,
            }
        }
    }
}

impl TypeParser<'_> {
    /// The node order of `sf`, built at the first call for that file. The
    /// rule runner makes one type parser for each file and drops it at the
    /// end of the file, so the order lives for one file's rules.
    pub fn node_order(&mut self, sf: Node) -> Rc<NodeOrder> {
        match &self.node_order {
            Some(order) if order.root() == sf => order.clone(),
            _ => {
                let order = Rc::new(NodeOrder::build(sf));
                self.node_order = Some(order.clone());
                order
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::frontend::parser::{SourceFileParseOptions, parse_source_file};

    fn parse(source: &'static str) -> Node {
        let opts = SourceFileParseOptions {
            file_name: "/test.ts".to_string(),
            ..Default::default()
        };
        parse_source_file(&opts, source, ScriptKind::TS).root
    }

    fn walk_nodes(n: Node, out: &mut Vec<Node>) {
        out.push(n);
        n.for_each_child(|c| {
            walk_nodes(c, out);
            false
        });
    }

    #[test]
    fn order_matches_the_recursive_walk() {
        let sf = parse(
            "const a = f(1, [2, 3]);\nclass C<T> extends B { m(x: T) { return x ? g() : h; } }\n",
        );
        let order = NodeOrder::build(sf);
        let mut expect = Vec::new();
        walk_nodes(sf, &mut expect);
        assert_eq!(order.nodes(), &expect[..]);
        for (i, &n) in order.nodes().iter().enumerate() {
            let kids: Vec<Node> = order.children(i as u32).map(|c| order.node(c)).collect();
            let want: Vec<Node> = n.iter_children().collect();
            assert_eq!(kids, want);
        }
    }

    // PORT: no Go test; Go `visitNodes` (ast.go:38) and the rule walks
    // (schema_number.go:46). A nil list entry (a factory list) is not in
    // the order, as the Go walks skip it.
    #[test]
    fn order_skips_a_nil_list_entry() {
        let f = NodeFactory::new();
        let a = f.new_identifier("a");
        let b = f.new_identifier("b");
        let array = f.new_array_literal_expression(f.new_node_list(&[a, Node::NIL, b]), false);
        let order = NodeOrder::build(array);
        assert_eq!(order.nodes(), &[array, a, b]);
        let kids: Vec<Node> = order.children(0).map(|c| order.node(c)).collect();
        assert_eq!(kids, [a, b]);
    }

    #[test]
    fn walks_keep_the_go_orders() {
        let sf = parse("f(a, g(b));\nlet x = [c, d];\n");
        let order = NodeOrder::build(sf);
        // Pre-order with a skip: the subtree of each call is skipped.
        let mut seen = Vec::new();
        order.walk_preorder(|n| {
            seen.push(n);
            if n.kind() == SyntaxKind::CallExpression {
                Walk::SkipChildren
            } else {
                Walk::Descend
            }
        });
        let mut expect = Vec::new();
        fn rec(n: Node, out: &mut Vec<Node>) {
            out.push(n);
            if n.kind() != SyntaxKind::CallExpression {
                n.for_each_child(|c| {
                    rec(c, out);
                    false
                });
            }
        }
        rec(sf, &mut expect);
        assert_eq!(seen, expect);
        // The stack walk of the rules (`nodeToVisit`), on indexes.
        let mut seen = Vec::new();
        let mut stack: Vec<u32> = order.children(0).collect();
        while let Some(i) = stack.pop() {
            seen.push(order.node(i));
            stack.extend(order.children(i));
        }
        let mut expect = Vec::new();
        let mut stack: Vec<Node> = sf.iter_children().collect();
        while let Some(n) = stack.pop() {
            expect.push(n);
            stack.extend(n.iter_children());
        }
        assert_eq!(seen, expect);
    }
}
