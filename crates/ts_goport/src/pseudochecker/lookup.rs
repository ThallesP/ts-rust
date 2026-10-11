//! Port of Go `pseudochecker/lookup.go`.

use crate::prelude::*;

use super::PseudoChecker;
use super::types::*;

// PORT: every method that can reach a `node.Symbol.Declarations` read takes
// `symbols: &SymbolArena` (the checker's arena) as its first parameter. See
// the note on `PseudoChecker` in mod.rs.
// PORT: Go `debug.FailBadSyntaxKind` panics; so does the port
// (`gostd::debug::fail_bad_syntax_kind`). Go returns
// `nil` after it, which is unreachable, so the Rust return type is
// `Rc<PseudoType>` without `Option`, and Go `expr != nil` checks are always
// true.
impl PseudoChecker {
    // Go: pseudochecker/lookup.go:11 GetReturnTypeOfSignature
    pub fn get_return_type_of_signature(
        &self,
        symbols: &SymbolArena,
        signature_node: Node,
    ) -> Rc<PseudoType> {
        match signature_node.kind() {
            SyntaxKind::GetAccessor => self.get_type_of_accessor(symbols, signature_node),
            SyntaxKind::MethodDeclaration
            | SyntaxKind::FunctionDeclaration
            | SyntaxKind::Constructor
            | SyntaxKind::MethodSignature
            | SyntaxKind::CallSignature
            | SyntaxKind::ConstructSignature
            | SyntaxKind::SetAccessor
            | SyntaxKind::IndexSignature
            | SyntaxKind::FunctionType
            | SyntaxKind::ConstructorType
            | SyntaxKind::FunctionExpression
            | SyntaxKind::ArrowFunction
            | SyntaxKind::JsDocSignature => {
                self.create_return_from_signature(symbols, signature_node)
            }
            _ => crate::gostd::debug::fail_bad_syntax_kind(
                signature_node.kind(),
                Some("Node needs to be an inferrable node"),
            ),
        }
    }

    // Go: pseudochecker/lookup.go:26 GetTypeOfAccessor
    pub fn get_type_of_accessor(&self, symbols: &SymbolArena, accessor: Node) -> Rc<PseudoType> {
        self.type_from_accessor(symbols, accessor)
    }

    // Go: pseudochecker/lookup.go:30 GetTypeOfExpression
    pub fn get_type_of_expression(&self, symbols: &SymbolArena, node: Node) -> Rc<PseudoType> {
        self.type_from_expression(symbols, node)
    }

    // Go: pseudochecker/lookup.go:34 GetTypeOfDeclaration
    pub fn get_type_of_declaration(&self, symbols: &SymbolArena, node: Node) -> Rc<PseudoType> {
        match node.kind() {
            SyntaxKind::Parameter => self.type_from_parameter(symbols, node),
            SyntaxKind::VariableDeclaration => self.type_from_variable(symbols, node),
            SyntaxKind::PropertySignature
            | SyntaxKind::PropertyDeclaration
            | SyntaxKind::JsDocPropertyTag => self.type_from_property(symbols, node),
            SyntaxKind::BindingElement => new_pseudo_type_no_result(node),
            SyntaxKind::ExportAssignment => self.type_from_expression(symbols, node.expression()),
            SyntaxKind::PropertyAccessExpression
            | SyntaxKind::ElementAccessExpression
            | SyntaxKind::BinaryExpression => self.type_from_expando_property(node),
            SyntaxKind::PropertyAssignment | SyntaxKind::ShorthandPropertyAssignment => {
                self.type_from_property_assignment(symbols, node)
            }
            SyntaxKind::CallExpression => {
                let kind = get_assignment_declaration_kind(node);
                // TODO: How much of the checker's getTypeFromPropertyDescriptor is worth trying to emulate over ASTs?
                if kind == JSDeclarationKind::OBJECT_DEFINE_PROPERTY_VALUE {
                    // !!!
                } else if kind == JSDeclarationKind::OBJECT_DEFINE_PROPERTY_EXPORTS {
                    // !!!
                }
                new_pseudo_type_no_result(node)
            }
            _ => crate::gostd::debug::fail_bad_syntax_kind(
                node.kind(),
                Some("node needs to be an inferrable node"),
            ),
        }
    }

    // Go: pseudochecker/lookup.go:69 typeFromPropertyAssignment
    fn type_from_property_assignment(&self, symbols: &SymbolArena, node: Node) -> Rc<PseudoType> {
        let annotation = node.type_();
        if annotation.is_some() {
            return new_pseudo_type_direct(annotation);
        }
        if node.kind() == SyntaxKind::PropertyAssignment {
            let init = node.initializer();
            if init.is_some() {
                let expr = self.type_from_expression(symbols, init);
                if expr.kind != PseudoTypeKind::INFERRED
                    || !expr.as_pseudo_type_inferred().error_nodes.is_empty()
                {
                    return expr;
                }
                // fallback to NoResult if PseudoTypeKindInferred without error nodes
            }
        }
        new_pseudo_type_no_result(node)
    }

    // Go: pseudochecker/lookup.go:88 typeFromExpandoProperty
    /// This is _not_ redundant with the reparser; see how expandoFunctionSymbolProperty.ts and similar behaves
    fn type_from_expando_property(&self, node: Node) -> Rc<PseudoType> {
        let declared_type = node.type_();
        if declared_type.is_some() {
            return new_pseudo_type_direct(declared_type);
        }
        // While `node` is an expression, as an expando, it should also always be a
        // declaration with a `.Symbol()` which requires declaration fallback handling
        new_pseudo_type_no_result(node)
    }

    // Go: pseudochecker/lookup.go:98 typeFromProperty
    fn type_from_property(&self, symbols: &SymbolArena, node: Node) -> Rc<PseudoType> {
        let t = node.type_();
        if t.is_some() {
            return new_pseudo_type_direct(t);
        }
        if is_property_declaration(node) {
            let init = node.initializer();
            if init.is_some() && !is_contextually_typed(node) {
                // explicit fail on readonly template literals to allow for literal freshness in the future
                if has_modifier(node, ModifierFlags::READONLY) && is_template_expression(init) {
                    return new_pseudo_type_no_result(node);
                }
                let expr = self.type_from_expression(symbols, init);
                if expr.kind != PseudoTypeKind::INFERRED
                    || !expr.as_pseudo_type_inferred().error_nodes.is_empty()
                {
                    let postfix_token = node.postfix_token();
                    if expr.kind != PseudoTypeKind::DIRECT
                        && postfix_token.is_some()
                        && postfix_token.kind() == SyntaxKind::QuestionToken
                    {
                        // type comes from the initializer expression on a property with a `?` - add `| undefined` to the type
                        return add_undefined_if_definitely_required(expr);
                    }
                    return expr;
                }
                // fallback to NoResult if PseudoTypeKindInferred without error nodes
            }
        }
        new_pseudo_type_no_result(node)
    }

    // Go: pseudochecker/lookup.go:124 typeFromVariable
    fn type_from_variable(&self, symbols: &SymbolArena, declaration: Node) -> Rc<PseudoType> {
        let t = declaration.type_();
        if t.is_some() {
            return new_pseudo_type_direct(t);
        }
        let init = declaration.initializer();
        if init.is_some() && declaration.symbol().is_some() {
            let declarations = &symbols.sym(declaration.symbol()).declarations;
            if declarations.len() == 1
                || declarations
                    .iter()
                    .filter(|&&d| is_variable_declaration(d))
                    .count()
                    == 1
            {
                if !is_contextually_typed(declaration) {
                    // TODO: also should bail on expando declarations; reuse syntactic expando check used in declaration emit
                    // TODO: Strada forces an inference fallback on `const` variables with template expression initializers, to leave space for template literal freshness in the future
                    if is_var_const(declaration) && is_template_expression(init) {
                        return new_pseudo_type_no_result(declaration);
                    }
                    let expr = self.type_from_expression(symbols, init);
                    if expr.kind != PseudoTypeKind::INFERRED
                        || !expr.as_pseudo_type_inferred().error_nodes.is_empty()
                    {
                        return expr;
                    }
                    // fallback to NoResult if PseudoTypeKindInferred without error nodes
                }
            }
        }
        new_pseudo_type_no_result(declaration)
    }

    // Go: pseudochecker/lookup.go:146 typeFromAccessor
    fn type_from_accessor(&self, symbols: &SymbolArena, accessor: Node) -> Rc<PseudoType> {
        let accessor_declarations = get_all_accessor_declarations_for_declaration(
            accessor,
            &symbols.sym(accessor.symbol()).declarations,
        );
        let accessor_type = self
            .get_type_annotation_from_all_accessor_declarations(accessor, accessor_declarations);
        if accessor_type.is_some() && !is_type_predicate_node(accessor_type) {
            return new_pseudo_type_direct(accessor_type);
        }
        if accessor_declarations.get_accessor.is_some() {
            let mut res =
                self.create_return_from_signature(symbols, accessor_declarations.get_accessor);
            if res.kind == PseudoTypeKind::INFERRED
                && res.as_pseudo_type_inferred().error_nodes.is_empty()
            {
                let mut error_nodes = vec![accessor_declarations.get_accessor];
                if accessor_declarations.set_accessor.is_some() {
                    error_nodes.push(accessor_declarations.set_accessor);
                }
                let inferred = res.as_pseudo_type_inferred();
                let (expression, is_signature_return) =
                    (inferred.expression, inferred.is_signature_return);
                res = new_pseudo_type_inferred_with_errors(
                    expression,
                    is_signature_return,
                    error_nodes,
                ); // Move error up to the accessor
            }
            return res;
        }
        new_pseudo_type_no_result(accessor)
    }

    // Go: pseudochecker/lookup.go:166 getTypeAnnotationFromAllAccessorDeclarations
    fn get_type_annotation_from_all_accessor_declarations(
        &self,
        node: Node,
        accessors: AllAccessorDeclarations,
    ) -> Node {
        let mut accessor_type = self.get_type_annotation_from_accessor(node);
        if accessor_type.is_nil() && node != accessors.first_accessor {
            accessor_type = self.get_type_annotation_from_accessor(accessors.first_accessor);
        }
        if accessor_type.is_nil()
            && accessors.second_accessor.is_some()
            && node != accessors.second_accessor
        {
            accessor_type = self.get_type_annotation_from_accessor(accessors.second_accessor);
        }
        accessor_type
    }

    // Go: pseudochecker/lookup.go:177 getTypeAnnotationFromAccessor
    fn get_type_annotation_from_accessor(&self, node: Node) -> Node {
        if node.is_nil() {
            return Node::NIL;
        }
        // !!! TODO: support ripping return type off of .FullSignature
        if node.kind() == SyntaxKind::GetAccessor {
            return node.type_();
        }
        let parameters = node.parameter_list();
        if parameters.is_nil() || parameters.nodes().len() < 1 {
            return Node::NIL;
        }
        let p = parameters.nodes().get(0);
        if !is_parameter_declaration(p) {
            return Node::NIL;
        }
        p.type_()
    }

    // Go: pseudochecker/lookup.go:201 createReturnFromSignature
    /// does not return `nil`, returns a `NoResult` pseudotype instead
    fn create_return_from_signature(&self, symbols: &SymbolArena, fn_: Node) -> Rc<PseudoType> {
        if is_function_like(fn_) {
            // !!! TODO: support ripping return type off of .FullSignature
            let r = fn_.type_();
            if r.is_some() {
                return new_pseudo_type_direct(r);
            }
        }
        if is_value_signature_declaration(fn_) {
            return self.type_from_single_return_expression(symbols, fn_);
        }
        new_pseudo_type_no_result(fn_)
    }

    // Go: pseudochecker/lookup.go:216 typeFromSingleReturnExpression
    fn type_from_single_return_expression(
        &self,
        symbols: &SymbolArena,
        fn_: Node,
    ) -> Rc<PseudoType> {
        let mut candidate_expr = Node::NIL;
        if fn_.is_some() && !node_is_missing(fn_.body()) {
            let flags = get_function_flags(fn_);
            if flags.intersects(FunctionFlags::ASYNC_GENERATOR) {
                return new_pseudo_type_inferred(fn_, true);
            }

            let body = fn_.body();
            if is_block(body) {
                for_each_return_statement(body, |stmt| {
                    if stmt.parent() != body {
                        // Why bail on nested return statements?
                        candidate_expr = Node::NIL;
                        return true;
                    }
                    if candidate_expr.is_nil() {
                        candidate_expr = stmt.expression();
                    } else {
                        candidate_expr = Node::NIL;
                        return true;
                    }
                    false
                });
            } else {
                candidate_expr = body;
            }
        }
        if candidate_expr.is_some() {
            if is_contextually_typed(candidate_expr) {
                let mut t = Node::NIL;
                if candidate_expr.kind() == SyntaxKind::TypeAssertionExpression {
                    t = candidate_expr.type_();
                } else if candidate_expr.kind() == SyntaxKind::AsExpression {
                    t = candidate_expr.type_();
                }
                if t.is_some() && !is_const_type_reference(t) {
                    return new_pseudo_type_direct(t);
                }
            } else {
                return self.type_from_expression(symbols, candidate_expr);
            }
        }
        new_pseudo_type_inferred(fn_, true)
    }

    // Go: pseudochecker/lookup.go:262 typeFromExpression
    /// This is basically `checkExpression` for pseudotypes
    fn type_from_expression(&self, symbols: &SymbolArena, node: Node) -> Rc<PseudoType> {
        match node.kind() {
            SyntaxKind::OmittedExpression => return pseudo_type_undefined(),
            SyntaxKind::ParenthesizedExpression => {
                // assertions transformed on reparse, just unwrap
                return self.type_from_expression(symbols, node.expression());
            }
            SyntaxKind::Identifier => {
                // !!! TODO: in strada, this uses symbol information to ensure `node` refers to the global `undefined` symbol instead
                // we should probably import `resolveName` and use it here to check for the same; but we have to setup some barebones pseudoglobals for that to work!
                if node.text() == "undefined" {
                    return pseudo_type_undefined();
                }
            }
            SyntaxKind::NullKeyword => return pseudo_type_null(),
            SyntaxKind::ArrowFunction | SyntaxKind::FunctionExpression => {
                return self.type_from_function_like_expression(symbols, node);
            }
            SyntaxKind::TypeAssertionExpression | SyntaxKind::AsExpression => {
                return self.type_from_type_assertion(symbols, node.expression(), node.type_());
            }
            SyntaxKind::PrefixUnaryExpression => {
                if is_primitive_literal_value(node, true) {
                    return self.type_from_primitive_literal_prefix(node);
                }
            }
            SyntaxKind::ArrayLiteralExpression => {
                return self.type_from_array_literal(symbols, node);
            }
            SyntaxKind::ObjectLiteralExpression => {
                return self.type_from_object_literal(symbols, node);
            }
            SyntaxKind::ClassExpression => {
                // No possible annotation/directly mappable syntax
                return new_pseudo_type_inferred_with_errors(node, false, vec![node]);
            }
            SyntaxKind::TemplateExpression => {
                // templateLitWithHoles as const, not supported
                if is_in_const_context(node) {
                    return new_pseudo_type_inferred(node, false);
                }
                return new_pseudo_type_maybe_const_location(
                    node,
                    new_pseudo_type_inferred(node, false),
                    pseudo_type_string(),
                );
            }
            SyntaxKind::NumericLiteral => {
                return new_pseudo_type_maybe_const_location(
                    node,
                    new_pseudo_type_numeric_literal(node),
                    pseudo_type_number(),
                );
            }
            SyntaxKind::NoSubstitutionTemplateLiteral => {
                return new_pseudo_type_maybe_const_location(
                    node,
                    new_pseudo_type_string_literal(node),
                    pseudo_type_string(),
                );
            }
            SyntaxKind::StringLiteral => {
                return new_pseudo_type_maybe_const_location(
                    node,
                    new_pseudo_type_string_literal(node),
                    pseudo_type_string(),
                );
            }
            SyntaxKind::BigIntLiteral => {
                return new_pseudo_type_maybe_const_location(
                    node,
                    new_pseudo_type_big_int_literal(node),
                    pseudo_type_big_int(),
                );
            }
            SyntaxKind::TrueKeyword => {
                return new_pseudo_type_maybe_const_location(
                    node,
                    pseudo_type_true(),
                    pseudo_type_boolean(),
                );
            }
            SyntaxKind::FalseKeyword => {
                return new_pseudo_type_maybe_const_location(
                    node,
                    pseudo_type_false(),
                    pseudo_type_boolean(),
                );
            }
            _ => {}
        }
        new_pseudo_type_inferred(node, false)
    }

    // Go: pseudochecker/lookup.go:315 typeFromObjectLiteral
    fn type_from_object_literal(&self, symbols: &SymbolArena, node: Node) -> Rc<PseudoType> {
        let error_nodes = self.can_get_type_from_object_literal(node);
        // PORT: Go tests `errorNodes != nil`; a non-nil result always has at
        // least one element, so a non-empty Vec is the same test.
        if !error_nodes.is_empty() {
            return new_pseudo_type_inferred_with_errors(node, false, error_nodes);
        }
        // we are in a const context producing an object literal type, there are no shorthand or spread assignments
        let properties = node.property_list();
        if properties.is_nil() || properties.nodes().is_empty() {
            return new_pseudo_type_object_literal(Vec::new());
        }
        let mut results: Vec<Rc<PseudoObjectElement>> =
            Vec::with_capacity(properties.nodes().len());
        for e in properties.nodes().iter() {
            match e.kind() {
                SyntaxKind::MethodDeclaration => {
                    let postfix_token = e.postfix_token();
                    let optional = postfix_token.is_some()
                        && postfix_token.kind() == SyntaxKind::QuestionToken;
                    if e.full_signature().is_some() {
                        results.push(new_pseudo_property_assignment(
                            false,
                            e.name(),
                            optional,
                            new_pseudo_type_direct(e.full_signature()),
                        ));
                    } else {
                        results.push(new_pseudo_object_method(
                            e,
                            e.name(),
                            optional,
                            self.clone_type_parameters(e.type_parameter_list()),
                            self.clone_parameters(symbols, e.parameter_list()),
                            self.create_return_from_signature(symbols, e),
                        ));
                    }
                }
                SyntaxKind::PropertyAssignment => {
                    let postfix_token = e.postfix_token();
                    results.push(new_pseudo_property_assignment(
                        false,
                        e.name(),
                        postfix_token.is_some()
                            && postfix_token.kind() == SyntaxKind::QuestionToken,
                        self.type_from_expression(symbols, e.initializer()),
                    ));
                }
                SyntaxKind::SetAccessor | SyntaxKind::GetAccessor => {
                    if let Some(member) = self.get_accessor_member(symbols, e, e.name()) {
                        results.push(member);
                    }
                }
                _ => {}
            }
        }
        new_pseudo_type_object_literal(results)
    }

    // Go: pseudochecker/lookup.go:363 getAccessorMember
    /// roughly analogous to typeFromObjectLiteralAccessor in strada
    // PORT: Go returns nil for "no member"; here that is `None`.
    fn get_accessor_member(
        &self,
        symbols: &SymbolArena,
        accessor: Node,
        name: Node,
    ) -> Option<Rc<PseudoObjectElement>> {
        let all_accessors = get_all_accessor_declarations_for_declaration(
            accessor,
            &symbols.sym(accessor.symbol()).declarations,
        ); // TODO: node preservation for late-bound accessor pairs?

        // TODO: handle pseudo-annotations from get accessor return positions?
        if all_accessors.get_accessor.is_some()
            && all_accessors.get_accessor.type_().is_some()
            && all_accessors.set_accessor.is_some()
            && !all_accessors.set_accessor.parameters().is_empty()
            && all_accessors
                .set_accessor
                .parameters()
                .get(0)
                .type_()
                .is_some()
        {
            // We have possible types for both accessors, we can't know if they are the same type so we keep both accessors

            if is_get_accessor_declaration(accessor) {
                return Some(new_pseudo_get_accessor(
                    accessor,
                    name,
                    false,
                    self.type_from_accessor(symbols, accessor),
                ));
            } else {
                return Some(new_pseudo_set_accessor(
                    accessor,
                    name,
                    false,
                    Rc::clone(&self.clone_parameters(symbols, accessor.parameter_list())[0]),
                ));
            }
        }

        if accessor == all_accessors.first_accessor {
            // only one annotated accessor; output a property - `readonly` for a single `get` accessor

            let accessor_type = self.type_from_accessor(symbols, accessor);
            let readonly =
                is_get_accessor_declaration(accessor) && all_accessors.second_accessor.is_nil();
            return Some(new_pseudo_property_assignment(
                readonly,
                name,
                false,
                accessor_type,
            ));
        }
        None
    }

    // Go: pseudochecker/lookup.go:406 canGetTypeFromObjectLiteral
    /// canGetTypeFromObjectLiteral checks whether an object literal can be typed by the pseudochecker.
    /// Returns nil if the object can be typed, or a slice of error nodes (shorthand/spread properties,
    /// non-literal computed names) that prevent typing.
    // PORT: Go nil is an empty Vec.
    fn can_get_type_from_object_literal(&self, node: Node) -> Vec<Node> {
        let properties = node.property_list();
        if properties.is_nil() || properties.nodes().is_empty() {
            return Vec::new(); // empty object, ok
        }
        let mut error_nodes: Vec<Node> = Vec::new();
        for e in properties.nodes().iter() {
            if e.flags().intersects(NodeFlags::THIS_NODE_HAS_ERROR) {
                error_nodes.push(e);
                continue;
            }
            if e.kind() == SyntaxKind::ShorthandPropertyAssignment
                || e.kind() == SyntaxKind::SpreadAssignment
            {
                error_nodes.push(e);
                continue;
            }
            if e.name().flags().intersects(NodeFlags::THIS_NODE_HAS_ERROR) {
                error_nodes.push(e.name());
                continue;
            }
            if e.name().kind() == SyntaxKind::PrivateIdentifier {
                error_nodes.push(e);
                continue;
            }
            if e.name().kind() == SyntaxKind::ComputedPropertyName {
                let expression = e.name().expression();
                if !is_primitive_literal_value(expression, false) {
                    error_nodes.push(e.name());
                }
            }
        }
        error_nodes
    }

    // Go: pseudochecker/lookup.go:438 typeFromArrayLiteral
    fn type_from_array_literal(&self, symbols: &SymbolArena, node: Node) -> Rc<PseudoType> {
        let error_nodes = self.can_get_type_from_array_literal(node);
        // PORT: Go tests `errorNodes != nil`; see typeFromObjectLiteral.
        if !error_nodes.is_empty() {
            return new_pseudo_type_inferred_with_errors(node, false, error_nodes);
        }
        if is_in_const_context(node) && is_contextually_typed(node) {
            return new_pseudo_type_inferred(node, false); // expr in an as const cast with a contextual type has variable readonly state, bail
        }
        // we are in a const context producing a tuple type, there are no spread elements
        let elements = node.elements();
        let mut results: Vec<Rc<PseudoType>> = Vec::with_capacity(elements.len());
        for e in elements.iter() {
            results.push(self.type_from_expression(symbols, e));
        }
        new_pseudo_type_tuple(results)
    }

    // Go: pseudochecker/lookup.go:457 canGetTypeFromArrayLiteral
    /// canGetTypeFromArrayLiteral checks whether an array literal can be typed by the pseudochecker.
    /// Returns nil if the array can be typed, or a slice of error nodes that prevent typing.
    /// For non-const arrays, the error node is the array expression itself.
    /// For const arrays with spreads, the error node is the spread element.
    // PORT: Go nil is an empty Vec.
    fn can_get_type_from_array_literal(&self, node: Node) -> Vec<Node> {
        if !is_in_const_context(node) {
            return vec![node];
        }
        for e in node.elements().iter() {
            if e.kind() == SyntaxKind::SpreadElement {
                return vec![e];
            }
        }
        Vec::new()
    }

    // Go: pseudochecker/lookup.go:494 typeFromPrimitiveLiteralPrefix
    fn type_from_primitive_literal_prefix(&self, node: Node) -> Rc<PseudoType> {
        let mut expr = node;
        if node.operator() == SyntaxKind::PlusToken {
            expr = node.operand();
        }
        let inner = node.operand();
        if inner.kind() == SyntaxKind::BigIntLiteral {
            return new_pseudo_type_maybe_const_location(
                node,
                new_pseudo_type_big_int_literal(expr),
                pseudo_type_big_int(),
            );
        }
        if inner.kind() == SyntaxKind::NumericLiteral {
            return new_pseudo_type_maybe_const_location(
                node,
                new_pseudo_type_numeric_literal(expr),
                pseudo_type_number(),
            );
        }
        crate::gostd::debug::fail_bad_syntax_kind(inner.kind(), None)
    }

    // Go: pseudochecker/lookup.go:510 typeFromTypeAssertion
    fn type_from_type_assertion(
        &self,
        symbols: &SymbolArena,
        expression: Node,
        type_node: Node,
    ) -> Rc<PseudoType> {
        if is_const_type_reference(type_node) {
            return self.type_from_expression(symbols, expression);
        }
        new_pseudo_type_direct(type_node)
    }

    // Go: pseudochecker/lookup.go:517 typeFromFunctionLikeExpression
    fn type_from_function_like_expression(
        &self,
        symbols: &SymbolArena,
        node: Node,
    ) -> Rc<PseudoType> {
        if node.full_signature().is_some() {
            return new_pseudo_type_direct(node.full_signature());
        }
        let return_type = self.create_return_from_signature(symbols, node);
        let type_parameters = self.clone_type_parameters(node.type_parameter_list());
        let parameters = self.clone_parameters(symbols, node.parameter_list());
        new_pseudo_type_single_call_signature(node, parameters, type_parameters, return_type)
    }

    // Go: pseudochecker/lookup.go:532 cloneTypeParameters
    // PORT: Go returns `[]*ast.TypeParameterDeclaration`; nil is an empty Vec.
    fn clone_type_parameters(&self, nodes: NodeList) -> Vec<Node> {
        if nodes.is_nil() {
            return Vec::new();
        }
        if nodes.nodes().is_empty() {
            return Vec::new();
        }
        let mut result: Vec<Node> = Vec::with_capacity(nodes.nodes().len());
        for e in nodes.nodes().iter() {
            result.push(e);
        }
        result
    }

    // Go: pseudochecker/lookup.go:631 typeFromParameter
    fn type_from_parameter(&self, symbols: &SymbolArena, node: Node) -> Rc<PseudoType> {
        let parent = node.parent();
        if parent.kind() == SyntaxKind::SetAccessor {
            return self.get_type_of_accessor(symbols, parent);
        }
        // Fast path: no initializer means we never need parameter position info.
        if node.initializer().is_nil() {
            if node.type_().is_some() {
                return new_pseudo_type_direct(node.type_());
            }
            return new_pseudo_type_no_result(node);
        }
        let p = parent.parameters();
        let self_idx = p.iter().position(|n| n == node).map_or(-1, |i| i as i32);
        let last_required = last_required_param_index(p);
        self.type_from_parameter_worker(symbols, node, self_idx, last_required)
    }

    // Go: pseudochecker/lookup.go:649 typeFromParameterWorker
    fn type_from_parameter_worker(
        &self,
        symbols: &SymbolArena,
        node: Node,
        self_idx: i32,
        last_required: i32,
    ) -> Rc<PseudoType> {
        let parent = node.parent();
        if parent.kind() == SyntaxKind::SetAccessor {
            return self.get_type_of_accessor(symbols, parent);
        }
        let has_required_after = self_idx < last_required - 1;
        let declared_type = node.type_();
        if declared_type.is_some() {
            let result = new_pseudo_type_direct(declared_type);
            // When the parameter has an initializer and strict null checks are enabled,
            // check if `| undefined` needs to be added because there are required parameters after this one.
            // This mirrors the checker's getTypeOfParameter which adds optionality for initialized parameters.
            if self.strict_null_checks && node.initializer().is_some() && has_required_after {
                return add_undefined_if_definitely_required(result);
            }
            return result;
        }
        if node.initializer().is_some()
            && is_identifier(node.name())
            && !is_contextually_typed(node)
        {
            let mut expr = self.type_from_expression(symbols, node.initializer());
            if expr.kind == PseudoTypeKind::INFERRED
                && expr.as_pseudo_type_inferred().error_nodes.is_empty()
            {
                let expression = expr.as_pseudo_type_inferred().expression;
                expr = new_pseudo_type_inferred_with_errors(expression, false, vec![node]); // Move error up to the parameter
            }
            if !self.strict_null_checks {
                return expr;
            }
            if !has_required_after {
                return expr;
            }
            // if there is a non-optional parameter after this one, a `| undefined` will need to explicitly be emitted on this parameter, if it's not already there
            return add_undefined_if_definitely_required(expr);
        }
        // TODO: In strada, the ID checker doesn't infer a parameter type from binding pattern names, but the real checker _does_!
        // This means ID won't let you write, say, `({elem}) => false` without an annotation, even though it's trivially of type
        // `(p0: {elem: any}) => boolean` and error-free under `noImplicitAny: false`!
        // That limitation is retained here.
        new_pseudo_type_no_result(node)
    }

    // Go: pseudochecker/lookup.go:687 cloneParameters
    // PORT: Go nil is an empty Vec.
    fn clone_parameters(&self, symbols: &SymbolArena, nodes: NodeList) -> Vec<Rc<PseudoParameter>> {
        if nodes.is_nil() {
            return Vec::new();
        }
        if nodes.nodes().is_empty() {
            return Vec::new();
        }
        let last_required = last_required_param_index(nodes.nodes());
        let mut result: Vec<Rc<PseudoParameter>> = Vec::with_capacity(nodes.nodes().len());
        for (i, e) in nodes.nodes().iter().enumerate() {
            let i = i as i32;
            let mut optional = e.question_token().is_some();
            if !optional && e.initializer().is_some() {
                // A parameter with an initializer is optional only if all subsequent
                // parameters are also optional/have initializers/are rest parameters.
                // This matches the checker's isOptionalParameter semantics.
                optional = i >= last_required - 1;
            }
            result.push(new_pseudo_parameter(
                e.dot_dot_dot_token().is_some(),
                e.name(),
                optional,
                self.type_from_parameter_worker(symbols, e, i, last_required),
            ));
        }
        result
    }
}

// Go: pseudochecker/lookup.go:196 isValueSignatureDeclaration
fn is_value_signature_declaration(node: Node) -> bool {
    is_function_expression(node)
        || is_arrow_function(node)
        || is_method_declaration(node)
        || is_accessor(node)
        || is_function_declaration(node)
        || is_constructor_declaration(node)
}

// Go: pseudochecker/lookup.go:470 isConstContextPropagatingKind
/// See `isConstContext` in `checker.go` - this is basically any node kind mentioned in that
fn is_const_context_propagating_kind(kind: SyntaxKind) -> bool {
    matches!(
        kind,
        SyntaxKind::ArrayLiteralExpression
            | SyntaxKind::ObjectLiteralExpression
            | SyntaxKind::ParenthesizedExpression
            | SyntaxKind::SpreadElement
            | SyntaxKind::PropertyAssignment
            | SyntaxKind::ShorthandPropertyAssignment
            | SyntaxKind::TemplateSpan
            | SyntaxKind::PrefixUnaryExpression
    )
}

// Go: pseudochecker/lookup.go:482 IsInConstContext
/// IsInConstContext traverses up the parent chain to determine if the node is within a const context without needing any
/// persistent traversal scope tracking (which could be unreliable in the presence of `typeof` queries anyway!)
pub fn is_in_const_context(node: Node) -> bool {
    // An expression is in a const context if an ancestor is a const type maybeAssertion expression
    let maybe_assertion = find_ancestor(node.parent(), |n| {
        // stop traversing at assertions or anything not an array/object literal, since only those create or transfer const-ness
        is_assertion_expression(n) || !is_const_context_propagating_kind(n.kind())
    });
    is_const_assertion(maybe_assertion)
}

// Go: pseudochecker/lookup.go:546 isUndefinedPseudoType
fn is_undefined_pseudo_type(t: &PseudoType) -> bool {
    t.kind == PseudoTypeKind::UNDEFINED
        || (t.kind == PseudoTypeKind::MAYBE_CONST_LOCATION
            && is_undefined_pseudo_type(&t.as_pseudo_type_maybe_const_location().const_type))
}

// Go: pseudochecker/lookup.go:550 typeNodeCouldReferToUndefined
fn type_node_could_refer_to_undefined(mut node: Node) -> bool {
    while node.kind() == SyntaxKind::ParenthesizedType {
        node = node.type_();
    }
    match node.kind() {
        // these types require symbolic/type resolution to know if they definitely do or do not refer to `undefined`, so might (or definitely do)
        SyntaxKind::TypeReference
        | SyntaxKind::IndexedAccessType
        | SyntaxKind::TypeQuery
        | SyntaxKind::OptionalType
        | SyntaxKind::RestType
        | SyntaxKind::ImportType => true,
        SyntaxKind::IntersectionType => {
            // TODO: why is this not `core.Every`? strada treated unions and intersections the same, but logically every intersection member needs to contain a possible `undefined`
            // for the result type to contain `undefined`. Likely a bug persisting from strada.
            node.types()
                .nodes()
                .iter()
                .any(type_node_could_refer_to_undefined)
        }
        SyntaxKind::UnionType => node
            .types()
            .nodes()
            .iter()
            .any(type_node_could_refer_to_undefined),
        SyntaxKind::ConditionalType => true, // suspect - should be treated as a union of both branches instead, likely a bug persisted from strada
        SyntaxKind::TypeOperator => true, // suspect - always refers to a subset of `string | number | symbol` for `keyof` or `symbol` for `unique`
        SyntaxKind::TypePredicate => true, // suspect - always refers to `never` or `boolean`, depending on kind - considered possibly-`undefined` referencing for strada compat
        SyntaxKind::UndefinedKeyword => true,
        _ => false, // all other keywords, literal types, function-y types, array/tuple types, type literals, template types, this types
    }
}

// Go: pseudochecker/lookup.go:578 CouldAlreadyReferToUndefinedType
/// see this as the inverse of `canAddUndefined` in `expressionToTypeNode` in strada
pub fn could_already_refer_to_undefined_type(t: &PseudoType) -> bool {
    if t.kind == PseudoTypeKind::NO_RESULT
        || t.kind == PseudoTypeKind::INFERRED
        || is_undefined_pseudo_type(t)
    {
        return true;
    }
    if t.kind == PseudoTypeKind::MAYBE_CONST_LOCATION {
        let mc = t.as_pseudo_type_maybe_const_location();
        return could_already_refer_to_undefined_type(&mc.regular_type); // if we're even asking this question, it's not a `const` location
    }
    if t.kind == PseudoTypeKind::DIRECT {
        // inspect the direct type node
        let node = t.as_pseudo_type_direct().type_node;
        return type_node_could_refer_to_undefined(node);
    }
    if t.kind == PseudoTypeKind::UNION {
        return t
            .as_pseudo_type_union()
            .types
            .iter()
            .any(|m| could_already_refer_to_undefined_type(m));
    }
    false
}

// Go: pseudochecker/lookup.go:597 isOptionalInitializedOrRestParameter
fn is_optional_initialized_or_rest_parameter(node: Node) -> bool {
    if node.dot_dot_dot_token().is_some()
        || node.initializer().is_some()
        || node.question_token().is_some()
    {
        return true;
    }
    false
}

// Go: pseudochecker/lookup.go:610 lastRequiredParamIndex
/// lastRequiredParamIndex returns the index just past the last required parameter
/// in the list. A parameter is "required" if it has no question token, no initializer,
/// and no rest token. This is computed in a single reverse pass so callers can
/// determine "has required parameter after index i" with `i+1 < lastRequired`
/// (equivalently, `i < lastRequired-1`) in O(1).
// PORT: takes a `NodeSlice` (Go `[]*ast.Node` from a NodeList) to avoid a copy.
fn last_required_param_index(params: NodeSlice) -> i32 {
    // Go: `slices.Backward` (ts#63902).
    for i in (0..params.len()).rev() {
        let param = params.get(i);
        if !is_optional_initialized_or_rest_parameter(param) {
            return i as i32 + 1;
        }
    }
    0
}

// Go: pseudochecker/lookup.go:619 addUndefinedIfDefinitelyRequired
fn add_undefined_if_definitely_required(expr: Rc<PseudoType>) -> Rc<PseudoType> {
    // If `expr` doesn't already contain `| undefined` or a direct/inferred type that may contain `undefined`, add `| undefined`
    // in Strada, this reached into the checker to see if `undefined` was necessary, using `isRequiredOptionalParameter` from the emit resolver,
    // but that's not required on top of the syntactic checks to get the same behavior. (If we get the type wrong, it'll mismatch later and be discarded
    // for an inference error since corsa actually validates that pseudotypes semantically match the inferred type the checker produces)
    if could_already_refer_to_undefined_type(&expr) {
        return expr; // will just error later, more like than not, unless the `undefined` is explicit in the pseudo
    }
    // Explicitly add an `| undefined`
    new_pseudo_type_union(vec![expr, pseudo_type_undefined()])
}

// Go: pseudochecker/lookup.go:715 isContextuallyTyped
fn is_contextually_typed(node: Node) -> bool {
    find_ancestor(node.parent(), |n| {
        // Functions calls or parent type annotations (but not the return type of a function expression) may impact the inferred type and local inference is unreliable
        if is_call_expression(n) {
            return true;
        }
        if is_satisfies_expression(n) {
            return true;
        }
        if (is_variable_parameter_or_property(n) || is_assertion_expression(n))
            && n.type_().is_some()
            && !is_const_assertion(n)
        {
            return true;
        }
        is_jsx_element(n) || is_jsx_expression(n)
    })
    .is_some()
}

#[cfg(test)]
mod debug_site_tests {
    use super::*;
    use crate::core::go_panic_text;
    use crate::frontend::parser::{SourceFileParseOptions, parse_source_file};
    use crate::frontend::tspath::Path;
    use crate::pseudochecker::new_pseudo_checker;

    // Go: ls/findallreferences.go:2103 forEachDescendantOfKind (the ls copy is in
    // the upper crate).
    fn for_each_descendant_of_kind(node: Node, kind: SyntaxKind, action: &mut dyn FnMut(Node)) {
        node.for_each_child(|child| {
            if child.kind() == kind {
                action(child);
            }
            for_each_descendant_of_kind(child, kind, &mut *action);
            false
        });
    }

    /// The last node of `kind` in a parse of `text`.
    fn node_of_kind(text: &'static str, kind: SyntaxKind) -> Node {
        let file = parse_source_file(
            &SourceFileParseOptions {
                file_name: "/a.ts".to_string(),
                path: Path("/a.ts".to_string()),
                ..Default::default()
            },
            text,
            ScriptKind::TS,
        )
        .root;
        let mut found = Node::NIL;
        for_each_descendant_of_kind(file, kind, &mut |n| found = n);
        assert!(!found.is_nil(), "no {kind:?} in {text:?}");
        found
    }

    // Go pseudochecker/lookup.go:21, :64 and :506 call
    // `debug.FailBadSyntaxKind` for a node the pseudochecker cannot type.
    #[test]
    fn bad_node_kinds_are_go_debug_failures() {
        let pc = new_pseudo_checker(true, false);
        let symbols = SymbolArena::new();
        let ident = node_of_kind("x;", SyntaxKind::Identifier);
        assert_eq!(
            go_panic_text(|| {
                pc.get_return_type_of_signature(&symbols, ident);
            }),
            "Debug failure. Node needs to be an inferrable node\nNode KindIdentifier was unexpected."
        );
        assert_eq!(
            go_panic_text(|| {
                pc.get_type_of_declaration(&symbols, ident);
            }),
            "Debug failure. node needs to be an inferrable node\nNode KindIdentifier was unexpected."
        );
        let prefix = node_of_kind("-x;", SyntaxKind::PrefixUnaryExpression);
        assert_eq!(
            go_panic_text(|| {
                pc.type_from_primitive_literal_prefix(prefix);
            }),
            "Debug failure. Unexpected node.\nNode KindIdentifier was unexpected."
        );
    }
}
