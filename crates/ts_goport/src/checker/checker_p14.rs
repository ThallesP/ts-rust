//! Port of typescript-go `internal/checker/checker.go` lines 12101-13024.
//!
//! PORT: Go `c.error(...)` returns the `*ast.Diagnostic` it already added, and
//! some Go callers mutate it afterwards (`AddRelatedInfo`). Our `Diagnostic`
//! is owned, so those callers build the diagnostic with
//! `new_diagnostic_for_node`, finish it, then call `add_diagnostic`. That is
//! exactly what Go `c.error` does, in the same order of effects.
//!
//! PORT: Go `func(left *Type, right *Type) bool` parameters become
//! `&mut dyn FnMut(&mut Checker, TypeId, TypeId) -> bool` (wrapped in
//! `Option` where Go passes nil).

use crate::diagnostics::Message;
use crate::prelude::*;

impl Checker {
    // Go: checker/checker.go:12373 tryGetThisTypeAt
    pub fn try_get_this_type_at(&mut self, node: Node) -> TypeId {
        self.try_get_this_type_at_ex(
            node,
            true,      /*includeGlobalThis*/
            Node::NIL, /*container*/
        )
    }

    // Go: checker/checker.go:12377 TryGetThisTypeAtEx
    // PORT: exported and unexported Go methods share the snake name
    // `try_get_this_type_at_ex`, so the exported one gets `_exported`.
    pub fn try_get_this_type_at_ex_exported(
        &mut self,
        node: Node,
        include_global_this: bool,
        container: Node,
    ) -> TypeId {
        let reparsed = get_reparsed_node_for_node(node);
        if reparsed.flags().intersects(NodeFlags::JS_DOC)
            && !reparsed.flags().intersects(NodeFlags::REPARSED)
        {
            return TypeId::NIL; // Binder doesn't process non-reparsed JSDoc nodes
        }
        self.try_get_this_type_at_ex(
            reparsed,
            include_global_this,
            get_reparsed_node_for_node(container),
        )
    }

    // Go: checker/checker.go:12385 tryGetThisTypeAtEx
    pub fn try_get_this_type_at_ex(
        &mut self,
        node: Node,
        include_global_this: bool,
        container: Node,
    ) -> TypeId {
        let mut container = container;
        if container.is_nil() {
            container = self.get_this_container(
                node, false, /*includeArrowFunctions*/
                false, /*includeClassComputedPropertyName*/
            );
        }
        if is_function_like(container)
            && (!self.is_in_parameter_initializer_before_containing_function(node)
                || get_this_parameter(container).is_some())
        {
            let mut sig = self.get_signature_of_full_signature_type(container);
            if sig.is_nil() {
                sig = self.get_signature_from_declaration(container);
            }
            let mut this_type = self.get_this_type_of_signature(sig);
            // Note: a parameter initializer should refer to class-this unless function-this is explicitly annotated.
            // If this is a function in a JS file, it might be a class method.
            if this_type.is_nil() {
                this_type = self.get_contextual_this_parameter_type(container);
            }
            if this_type.is_some() {
                return self.get_flow_type_of_reference(node, this_type);
            }
        }
        if container.parent().is_some() && is_class_like(container.parent()) {
            let symbol = self.get_symbol_of_declaration(container.parent());
            let t;
            if is_static(container) {
                t = self.get_type_of_symbol(symbol);
            } else {
                let declared = self.get_declared_type_of_symbol(symbol);
                t = self.ty(declared).as_interface_type().this_type;
            }
            return self.get_flow_type_of_reference(node, t);
        }
        if is_source_file(container) {
            // look up in the source file's locals or exports
            if with_source_file_info(container, |info| info.external_module_indicator).is_some() {
                // TODO: Maybe issue a better error than 'object is possibly undefined'
                return self.undefined_type;
            }
            if include_global_this {
                return self.get_type_of_symbol(self.global_this_symbol);
            }
        }
        TypeId::NIL
    }

    // Go: checker/checker.go:12427 getThisContainer
    pub fn get_this_container(
        &self,
        node: Node,
        include_arrow_functions: bool,
        include_class_computed_property_name: bool,
    ) -> Node {
        let mut node = node;
        loop {
            node = node.parent();
            if node.is_nil() {
                // If we never pass in a SourceFile, this should be unreachable, since we'll stop when we reach that.
                panic!("No parent in getThisContainer");
            }
            match node.kind() {
                SyntaxKind::ComputedPropertyName => {
                    // If the grandparent node is an object literal (as opposed to a class),
                    // then the computed property is not a 'this' container.
                    // A computed property name in a class needs to be a this container
                    // so that we can error on it.
                    if include_class_computed_property_name && is_class_like(node.parent().parent())
                    {
                        return node;
                    }
                    // If this is a computed property, then the parent should not
                    // make it a this container. The parent might be a property
                    // in an object literal, like a method or accessor. But in order for
                    // such a parent to be a this container, the reference must be in
                    // the *body* of the container.
                    node = node.parent().parent();
                }
                SyntaxKind::Decorator => {
                    // Decorators are always applied outside of the body of a class or method.
                    if node.parent().kind() == SyntaxKind::Parameter
                        && is_class_element(node.parent().parent())
                    {
                        // If the decorator's parent is a Parameter, we resolve the this container from
                        // the grandparent class declaration.
                        node = node.parent().parent();
                    } else if is_class_element(node.parent()) {
                        // If the decorator's parent is a class element, we resolve the 'this' container
                        // from the parent class declaration.
                        node = node.parent();
                    }
                }
                SyntaxKind::ArrowFunction => {
                    if !include_arrow_functions {
                        continue;
                    }
                    // Go: fallthrough
                    return node;
                }
                SyntaxKind::FunctionDeclaration
                | SyntaxKind::FunctionExpression
                | SyntaxKind::ModuleDeclaration
                | SyntaxKind::ClassStaticBlockDeclaration
                | SyntaxKind::PropertyDeclaration
                | SyntaxKind::PropertySignature
                | SyntaxKind::MethodDeclaration
                | SyntaxKind::MethodSignature
                | SyntaxKind::Constructor
                | SyntaxKind::GetAccessor
                | SyntaxKind::SetAccessor
                | SyntaxKind::CallSignature
                | SyntaxKind::ConstructSignature
                | SyntaxKind::IndexSignature
                | SyntaxKind::EnumDeclaration
                | SyntaxKind::SourceFile => {
                    return node;
                }
                _ => {}
            }
        }
    }

    // Go: checker/checker.go:12474 isInParameterInitializerBeforeContainingFunction
    // PERF: parentname1. Each step reads the parent and its kind once
    // through a view (`NodeRef`), as Go loads `node.Parent` and its `Kind`.
    // The walk had 4 to 5 `parent()` reads per step, each a registry
    // lookup (checkline1). The tests and their order are Go's.
    pub fn is_in_parameter_initializer_before_containing_function(&self, node: Node) -> bool {
        let mut node = NodeRef::new(node);
        let mut in_binding_initializer = false;
        loop {
            let parent = node.parent();
            if parent.is_nil() {
                break;
            }
            let parent_kind = parent.kind();
            if is_function_like_kind(parent_kind) {
                break;
            }
            if parent_kind == SyntaxKind::Parameter
                && (in_binding_initializer || parent.initializer() == node.node())
            {
                return true;
            }

            if parent_kind == SyntaxKind::BindingElement && parent.initializer() == node.node() {
                in_binding_initializer = true;
            }

            node = parent;
        }

        false
    }

    // Go: checker/checker.go:12493 checkThisInStaticClassFieldInitializerInDecoratedClass
    pub fn check_this_in_static_class_field_initializer_in_decorated_class(
        &mut self,
        this_expression: Node,
        container: Node,
    ) {
        if is_property_declaration(container)
            && has_static_modifier(container)
            && self.legacy_decorators
        {
            let initializer = container.initializer();
            if initializer.is_some()
                && initializer.loc().contains_inclusive(this_expression.pos())
                && has_decorators(container.parent())
            {
                self.error(
                    this_expression,
                    diag::Cannot_use_this_in_a_static_property_initializer_of_a_decorated_class,
                    args![],
                );
            }
        }
    }

    // Go: checker/checker.go:12502 checkThisBeforeSuper
    pub fn check_this_before_super(
        &mut self,
        node: Node,
        container: Node,
        diagnostic_message: &'static Message,
    ) {
        let containing_class_decl = container.parent();
        let base_type_node = get_class_extends_heritage_element(containing_class_decl);
        // If a containing class does not have extends clause or the class extends null
        // skip checking whether super statement is called before "this" accessing.
        if base_type_node.is_some() && !self.class_declaration_extends_null(containing_class_decl) {
            // PORT: Go `node.FlowNodeData() != nil` is `canHaveFlowNode(node)`.
            if can_have_flow_node(node)
                && !self.is_post_super_flow_node(node.flow_node(), false /*noCacheCheck*/)
            {
                self.error(node, diagnostic_message, args![]);
            }
        }
    }

    // Check if the given class-declaration extends null then return true.
    // Otherwise, return false
    // @param classDecl a class declaration to check if it extends null
    // Go: checker/checker.go:12519 classDeclarationExtendsNull
    pub fn class_declaration_extends_null(&mut self, class_decl: Node) -> bool {
        let class_symbol = self.get_symbol_of_declaration(class_decl);
        let class_instance_type = self.get_declared_type_of_symbol(class_symbol);
        let base_constructor_type = self.get_base_constructor_type_of_class(class_instance_type);
        base_constructor_type == self.null_widening_type
    }

    // Go: checker/checker.go:12526 checkAssertion
    pub fn check_assertion(&mut self, node: Node, check_mode: CheckMode) -> TypeId {
        if node.kind() == SyntaxKind::TypeAssertionExpression {
            let file = get_source_file_of_node(node);
            if file.is_some()
                && crate::frontend::tspath::file_extension_is_one_of(
                    source_file_file_name(file),
                    &[
                        crate::frontend::tspath::EXTENSION_MTS,
                        crate::frontend::tspath::EXTENSION_CTS,
                    ],
                )
            {
                self.grammar_error_on_node(
                    node,
                    diag::This_syntax_is_reserved_in_files_with_the_mts_or_cts_extension_Use_an_as_expression_instead,
                    args![],
                );
            }
            if self.should_check_erasable_syntax(node) {
                let sf = get_source_file_of_node(node);
                self.add_diagnostic(new_diagnostic(
                    sf,
                    TextRange::new(
                        skip_trivia(&source_file_text(sf), node.pos()),
                        node.expression().pos(),
                    ),
                    diag::This_syntax_is_not_allowed_when_erasableSyntaxOnly_is_enabled,
                    args![],
                ));
            }
        }
        let type_node = node.type_();
        let expr_type = self.check_expression_ex(node.expression(), check_mode);
        // Always check the type node so its identifiers are resolved. resolveName knows not
        // to resolve (or report an error for) the `const` in a `const` assertion, so this is
        // safe even for `x as const` and keeps diagnostics stable regardless of traversal order.
        self.check_source_element(type_node);
        if is_const_type_reference(type_node) {
            if !self.is_valid_const_assertion_argument(node.expression()) {
                self.error(
                    node.expression(),
                    diag::A_const_assertion_can_only_be_applied_to_references_to_enum_members_or_string_number_boolean_array_or_object_literals,
                    args![],
                );
            }
            return self.get_regular_type_of_literal_type(expr_type);
        }
        self.assertion_links.get(node).expr_type = expr_type;
        self.check_node_deferred(node);
        self.get_type_from_type_node(type_node)
    }

    // Go: checker/checker.go:12554 checkAssertionDeferred
    pub fn check_assertion_deferred(&mut self, node: Node) {
        let type_node = node.type_();
        let links_expr_type = self.assertion_links.get(node).expr_type;
        let base = self.get_base_type_of_literal_type(links_expr_type);
        let expr_type = self.get_regular_type_of_object_literal(base);
        let target_type = self.get_type_from_type_node(type_node);
        if !self.is_error_type(target_type) {
            let widened_type = self.get_widened_type(expr_type);
            if !self.is_type_comparable_to(target_type, widened_type) {
                let mut err_node = node;
                if type_node.flags().intersects(NodeFlags::REPARSED) {
                    err_node = type_node;
                }
                self.check_type_comparable_to(
                    expr_type,
                    target_type,
                    err_node,
                    Some(diag::Conversion_of_type_0_to_type_1_may_be_a_mistake_because_neither_type_sufficiently_overlaps_with_the_other_If_this_was_intentional_convert_the_expression_to_unknown_first),
                );
            }
        }
    }

    // Go: checker/checker.go:12570 checkBinaryExpression
    pub fn check_binary_expression(&mut self, node: Node, check_mode: CheckMode) -> TypeId {
        self.check_binary_like_expression(
            node.left(),
            node.operator_token(),
            node.right(),
            check_mode,
            node,
        )
    }

    // Go: checker/checker.go:12575 checkBinaryLikeExpression
    pub fn check_binary_like_expression(
        &mut self,
        left: Node,
        operator_token: Node,
        right: Node,
        check_mode: CheckMode,
        error_node: Node,
    ) -> TypeId {
        let operator = operator_token.kind();
        if operator == SyntaxKind::EqualsToken
            && (left.kind() == SyntaxKind::ObjectLiteralExpression
                || left.kind() == SyntaxKind::ArrayLiteralExpression)
        {
            let right_checked = self.check_expression_ex(right, check_mode);
            return self.check_destructuring_assignment(
                left,
                right_checked,
                check_mode,
                right.kind() == SyntaxKind::ThisKeyword,
            );
        }
        let mut left_type = self.check_expression_ex(left, check_mode);
        let mut right_type = self.check_expression_ex(right, check_mode);
        if is_logical_or_coalescing_binary_operator(operator) {
            let mut parent = left.parent().parent();
            while is_parenthesized_expression(parent)
                || is_logical_or_coalescing_binary_expression(parent)
            {
                parent = parent.parent();
            }
            if operator == SyntaxKind::AmpersandAmpersandToken || is_if_statement(parent) {
                let mut body = Node::NIL;
                if is_if_statement(parent) {
                    body = parent.then_statement();
                }
                self.check_testing_known_truthy_callable_or_awaitable_or_enum_member_type(
                    left, left_type, body,
                );
            }
            if is_logical_binary_operator(operator) {
                self.check_truthiness_of_type(left_type, left);
            }
        }
        match operator {
            SyntaxKind::AsteriskToken
            | SyntaxKind::AsteriskAsteriskToken
            | SyntaxKind::AsteriskEqualsToken
            | SyntaxKind::AsteriskAsteriskEqualsToken
            | SyntaxKind::SlashToken
            | SyntaxKind::SlashEqualsToken
            | SyntaxKind::PercentToken
            | SyntaxKind::PercentEqualsToken
            | SyntaxKind::MinusToken
            | SyntaxKind::MinusEqualsToken
            | SyntaxKind::LessThanLessThanToken
            | SyntaxKind::LessThanLessThanEqualsToken
            | SyntaxKind::GreaterThanGreaterThanToken
            | SyntaxKind::GreaterThanGreaterThanEqualsToken
            | SyntaxKind::GreaterThanGreaterThanGreaterThanToken
            | SyntaxKind::GreaterThanGreaterThanGreaterThanEqualsToken
            | SyntaxKind::BarToken
            | SyntaxKind::BarEqualsToken
            | SyntaxKind::CaretToken
            | SyntaxKind::CaretEqualsToken
            | SyntaxKind::AmpersandToken
            | SyntaxKind::AmpersandEqualsToken => {
                if left_type == self.silent_never_type || right_type == self.silent_never_type {
                    return self.silent_never_type;
                }
                left_type = self.check_non_null_type(left_type, left);
                right_type = self.check_non_null_type(right_type, right);
                // if a user tries to apply a bitwise operator to 2 boolean operands
                // try and return them a helpful suggestion
                if self.ty(left_type).flags.intersects(TypeFlags::BOOLEAN_LIKE)
                    && self
                        .ty(right_type)
                        .flags
                        .intersects(TypeFlags::BOOLEAN_LIKE)
                {
                    let suggested_operator = self.get_suggested_boolean_operator(operator);
                    if suggested_operator != SyntaxKind::Unknown {
                        self.error(
                            operator_token,
                            diag::The_0_operator_is_not_allowed_for_boolean_types_Consider_using_1_instead,
                            args![token_to_string(operator_token.kind()), token_to_string(suggested_operator)],
                        );
                        return self.number_type;
                    }
                }
                // otherwise just check each operand separately and report errors as normal
                let left_ok = self.check_arithmetic_operand_type(
                    left,
                    left_type,
                    diag::The_left_hand_side_of_an_arithmetic_operation_must_be_of_type_any_number_bigint_or_an_enum_type,
                    true, /*isAwaitValid*/
                );
                let right_ok = self.check_arithmetic_operand_type(
                    right,
                    right_type,
                    diag::The_right_hand_side_of_an_arithmetic_operation_must_be_of_type_any_number_bigint_or_an_enum_type,
                    true, /*isAwaitValid*/
                );
                let result_type;
                // If both are any or unknown, allow operation; assume it will resolve to number
                if self.is_type_assignable_to_kind(left_type, TypeFlags::ANY_OR_UNKNOWN)
                    && self.is_type_assignable_to_kind(right_type, TypeFlags::ANY_OR_UNKNOWN)
                    || !self.maybe_type_of_kind(left_type, TypeFlags::BIG_INT_LIKE)
                        && !self.maybe_type_of_kind(right_type, TypeFlags::BIG_INT_LIKE)
                {
                    result_type = self.number_type;
                } else if self.both_are_big_int_like(left_type, right_type) {
                    match operator {
                        SyntaxKind::GreaterThanGreaterThanGreaterThanToken
                        | SyntaxKind::GreaterThanGreaterThanGreaterThanEqualsToken => {
                            self.report_operator_error(
                                left_type, operator, right_type, error_node, None,
                            );
                        }
                        SyntaxKind::AsteriskAsteriskToken
                        | SyntaxKind::AsteriskAsteriskEqualsToken => {
                            if self.language_version < ScriptTarget::ES2016 {
                                self.error(
                                    error_node,
                                    diag::Exponentiation_cannot_be_performed_on_bigint_values_unless_the_target_option_is_set_to_es2016_or_later,
                                    args![],
                                );
                            }
                        }
                        _ => {}
                    }
                    result_type = self.bigint_type;
                } else {
                    self.report_operator_error(
                        left_type,
                        operator,
                        right_type,
                        error_node,
                        Some(&mut |c: &mut Checker, l: TypeId, r: TypeId| {
                            c.both_are_big_int_like(l, r)
                        }),
                    );
                    result_type = self.error_type;
                }
                if left_ok && right_ok {
                    self.check_assignment_operator(left, operator, right, left_type, result_type);
                    match operator {
                        SyntaxKind::LessThanLessThanToken
                        | SyntaxKind::LessThanLessThanEqualsToken
                        | SyntaxKind::GreaterThanGreaterThanToken
                        | SyntaxKind::GreaterThanGreaterThanEqualsToken
                        | SyntaxKind::GreaterThanGreaterThanGreaterThanToken
                        | SyntaxKind::GreaterThanGreaterThanGreaterThanEqualsToken => {
                            let rhs_eval = (self.evaluate.clone())(self, right, right);
                            if let Some(LiteralValue::Number(num_value)) = rhs_eval.value {
                                if num_value.abs() >= crate::jsnum::Number::new(32.0) {
                                    // Elevate from suggestion to error within an enum member
                                    self.error_or_suggestion(
                                        is_enum_member(walk_up_parenthesized_expressions(right.parent().parent())),
                                        error_node,
                                        diag::This_operation_can_be_simplified_This_shift_is_identical_to_0_1_2,
                                        args![
                                            get_text_of_node(left),
                                            token_to_string(operator),
                                            num_value.remainder(crate::jsnum::Number::new(32.0))
                                        ],
                                    );
                                }
                            }
                        }
                        _ => {}
                    }
                }
                result_type
            }
            SyntaxKind::PlusToken | SyntaxKind::PlusEqualsToken => {
                if left_type == self.silent_never_type || right_type == self.silent_never_type {
                    return self.silent_never_type;
                }
                if !self.is_type_assignable_to_kind(left_type, TypeFlags::STRING_LIKE)
                    && !self.is_type_assignable_to_kind(right_type, TypeFlags::STRING_LIKE)
                {
                    left_type = self.check_non_null_type(left_type, left);
                    right_type = self.check_non_null_type(right_type, right);
                }
                let mut result_type = TypeId::NIL;
                if self.is_type_assignable_to_kind_ex(
                    left_type,
                    TypeFlags::NUMBER_LIKE,
                    true, /*strict*/
                ) && self.is_type_assignable_to_kind_ex(
                    right_type,
                    TypeFlags::NUMBER_LIKE,
                    true, /*strict*/
                ) {
                    // Operands of an enum type are treated as having the primitive type Number.
                    // If both operands are of the Number primitive type, the result is of the Number primitive type.
                    result_type = self.number_type;
                } else if self.is_type_assignable_to_kind_ex(
                    left_type,
                    TypeFlags::BIG_INT_LIKE,
                    true, /*strict*/
                ) && self.is_type_assignable_to_kind_ex(
                    right_type,
                    TypeFlags::BIG_INT_LIKE,
                    true, /*strict*/
                ) {
                    // If both operands are of the BigInt primitive type, the result is of the BigInt primitive type.
                    result_type = self.bigint_type;
                } else if self.is_type_assignable_to_kind_ex(
                    left_type,
                    TypeFlags::STRING_LIKE,
                    true, /*strict*/
                ) || self.is_type_assignable_to_kind_ex(
                    right_type,
                    TypeFlags::STRING_LIKE,
                    true, /*strict*/
                ) {
                    // If one or both operands are of the String primitive type, the result is of the String primitive type.
                    result_type = self.string_type;
                } else if self.is_type_any(left_type) || self.is_type_any(right_type) {
                    // Otherwise, the result is of type Any.
                    // NOTE: unknown type here denotes error type. Old compiler treated this case as any type so do we.
                    if self.is_error_type(left_type) || self.is_error_type(right_type) {
                        result_type = self.error_type;
                    } else {
                        result_type = self.any_type;
                    }
                }
                // Symbols are not allowed at all in arithmetic expressions
                if result_type.is_some()
                    && !self.check_for_disallowed_es_symbol_operand(
                        left, right, left_type, right_type, operator,
                    )
                {
                    return result_type;
                }
                if result_type.is_nil() {
                    // Types that have a reasonably good chance of being a valid operand type.
                    // If both types have an awaited type of one of these, we'll assume the user
                    // might be missing an await without doing an exhaustive check that inserting
                    // await(s) will actually be a completely valid binary expression.
                    let close_enough_kind = TypeFlags::NUMBER_LIKE
                        | TypeFlags::BIG_INT_LIKE
                        | TypeFlags::STRING_LIKE
                        | TypeFlags::ANY_OR_UNKNOWN;
                    self.report_operator_error(
                        left_type,
                        operator,
                        right_type,
                        error_node,
                        Some(&mut move |c: &mut Checker, l: TypeId, r: TypeId| {
                            c.is_type_assignable_to_kind(l, close_enough_kind)
                                && c.is_type_assignable_to_kind(r, close_enough_kind)
                        }),
                    );
                    return self.any_type;
                }
                if operator == SyntaxKind::PlusEqualsToken {
                    self.check_assignment_operator(left, operator, right, left_type, result_type);
                }
                result_type
            }
            SyntaxKind::LessThanToken
            | SyntaxKind::GreaterThanToken
            | SyntaxKind::LessThanEqualsToken
            | SyntaxKind::GreaterThanEqualsToken => {
                if self.check_for_disallowed_es_symbol_operand(
                    left, right, left_type, right_type, operator,
                ) {
                    let l = self.check_non_null_type(left_type, left);
                    left_type = self.get_base_type_of_literal_type_for_comparison(l);
                    let r = self.check_non_null_type(right_type, right);
                    right_type = self.get_base_type_of_literal_type_for_comparison(r);
                    self.report_operator_error_unless(
                        left_type,
                        operator,
                        right_type,
                        error_node,
                        &mut |c: &mut Checker, left: TypeId, right: TypeId| {
                            if c.is_type_any(left) || c.is_type_any(right) {
                                return true;
                            }
                            let number_or_big_int_type = c.number_or_big_int_type;
                            let left_assignable_to_number =
                                c.is_type_assignable_to(left, number_or_big_int_type);
                            let right_assignable_to_number =
                                c.is_type_assignable_to(right, number_or_big_int_type);
                            left_assignable_to_number && right_assignable_to_number
                                || !left_assignable_to_number
                                    && !right_assignable_to_number
                                    && c.are_types_comparable(left, right)
                        },
                    );
                }
                self.boolean_type
            }
            SyntaxKind::EqualsEqualsToken
            | SyntaxKind::ExclamationEqualsToken
            | SyntaxKind::EqualsEqualsEqualsToken
            | SyntaxKind::ExclamationEqualsEqualsToken => {
                // We suppress errors in CheckMode.TypeOnly (meaning the invocation came from getTypeOfExpression). During
                // control flow analysis it is possible for operands to temporarily have narrower types, and those narrower
                // types may cause the operands to not be comparable. We don't want such errors reported (see #46475).
                if !check_mode.intersects(CheckMode::TYPE_ONLY) {
                    if (is_literal_expression_of_object(left) || is_literal_expression_of_object(right))
                        // only report for === and !== in JS, not == or !=
                        && (!is_in_js_file(left)
                            || (operator == SyntaxKind::EqualsEqualsEqualsToken || operator == SyntaxKind::ExclamationEqualsEqualsToken))
                    {
                        let eq_type = operator == SyntaxKind::EqualsEqualsToken
                            || operator == SyntaxKind::EqualsEqualsEqualsToken;
                        self.error(
                            error_node,
                            diag::This_condition_will_always_return_0_since_JavaScript_compares_objects_by_reference_not_value,
                            args![if eq_type { "false" } else { "true" }],
                        );
                    }
                    self.check_na_n_equality(error_node, operator, left, right);
                    self.report_operator_error_unless(
                        left_type,
                        operator,
                        right_type,
                        error_node,
                        &mut |c: &mut Checker, left: TypeId, right: TypeId| {
                            c.is_type_equality_comparable_to(left, right)
                                || c.is_type_equality_comparable_to(right, left)
                        },
                    );
                }
                self.boolean_type
            }
            SyntaxKind::InstanceOfKeyword => {
                self.check_instance_of_expression(left, right, left_type, right_type, check_mode)
            }
            SyntaxKind::InKeyword => self.check_in_expression(left, right, left_type, right_type),
            SyntaxKind::AmpersandAmpersandToken | SyntaxKind::AmpersandAmpersandEqualsToken => {
                let mut result_type = left_type;
                if self.has_type_facts(left_type, TypeFacts::TRUTHY) {
                    let mut t = left_type;
                    if !self.strict_null_checks {
                        t = self.get_base_type_of_literal_type(right_type);
                    }
                    let falsy = self.extract_definitely_falsy_types(t);
                    result_type = self.get_union_type(&[falsy, right_type]);
                }
                if operator == SyntaxKind::AmpersandAmpersandEqualsToken {
                    self.check_assignment_operator(left, operator, right, left_type, right_type);
                }
                result_type
            }
            SyntaxKind::BarBarToken | SyntaxKind::BarBarEqualsToken => {
                let mut result_type = left_type;
                if self.has_type_facts(left_type, TypeFacts::FALSY) {
                    let removed = self.remove_definitely_falsy_types(left_type);
                    let non_nullable = self.get_non_nullable_type(removed);
                    result_type = self.get_union_type_ex(
                        &[non_nullable, right_type],
                        UnionReduction::SUBTYPE,
                        None,
                        TypeId::NIL,
                    );
                }
                if operator == SyntaxKind::BarBarEqualsToken {
                    self.check_assignment_operator(left, operator, right, left_type, right_type);
                }
                result_type
            }
            SyntaxKind::QuestionQuestionToken | SyntaxKind::QuestionQuestionEqualsToken => {
                if operator == SyntaxKind::QuestionQuestionToken {
                    self.check_nullish_coalesce_operands(left, right);
                }
                let mut result_type = left_type;
                if self.has_type_facts(left_type, TypeFacts::EQ_UNDEFINED_OR_NULL) {
                    let non_nullable = self.get_non_nullable_type(left_type);
                    result_type = self.get_union_type_ex(
                        &[non_nullable, right_type],
                        UnionReduction::SUBTYPE,
                        None,
                        TypeId::NIL,
                    );
                }
                if operator == SyntaxKind::QuestionQuestionEqualsToken {
                    self.check_assignment_operator(left, operator, right, left_type, right_type);
                }
                result_type
            }
            SyntaxKind::EqualsToken => {
                self.check_assignment_operator(left, operator, right, left_type, right_type);
                right_type
            }
            SyntaxKind::CommaToken => {
                if !self.compiler_options.allow_unreachable_code.is_true()
                    && self.is_side_effect_free(left)
                    && !self.is_indirect_call(left.parent())
                {
                    let sf = get_source_file_of_node(left);
                    let start = skip_trivia(&source_file_text(sf), left.pos());
                    // PORT: Go `sf.Diagnostics()` is the parser diagnostics
                    // field, read here from `source_file_info(sf).diagnostics`.
                    let is_in_diag2657 = source_file_info(sf).diagnostics.iter().any(|d| {
                        if d.code()
                            != diag::JSX_expressions_must_have_one_parent_element.code() as i32
                        {
                            return false;
                        }
                        d.loc().contains(start)
                    });
                    if !is_in_diag2657 {
                        self.error(
                            left,
                            diag::Left_side_of_comma_operator_is_unused_and_has_no_side_effects,
                            args![],
                        );
                    }
                }
                right_type
            }
            _ => panic!("Unhandled case in checkBinaryLikeExpression"),
        }
    }

    // Go: checker/checker.go:12791 checkDestructuringAssignment
    pub fn check_destructuring_assignment(
        &mut self,
        node: Node,
        source_type: TypeId,
        check_mode: CheckMode,
        right_is_this: bool,
    ) -> TypeId {
        let mut source_type = source_type;
        let mut target;
        if is_shorthand_property_assignment(node) {
            let initializer = node.object_assignment_initializer();
            if initializer.is_some() {
                // In strict null checking mode, if a default value of a non-undefined type is specified, remove
                // undefined from the final type.
                if self.strict_null_checks {
                    let init_type = self.check_expression(initializer);
                    if !self.has_type_facts(init_type, TypeFacts::IS_UNDEFINED) {
                        source_type =
                            self.get_type_with_facts(source_type, TypeFacts::NE_UNDEFINED);
                    }
                }
                self.check_binary_like_expression(
                    node.name(),
                    node.equals_token(),
                    initializer,
                    check_mode,
                    Node::NIL,
                );
            }
            target = node.name();
        } else {
            target = node;
        }
        if is_binary_expression(target) && target.operator_token().kind() == SyntaxKind::EqualsToken
        {
            self.check_binary_expression(target, check_mode);
            target = target.left();
            // A default value is specified, so remove undefined from the final type.
            if self.strict_null_checks {
                source_type = self.get_type_with_facts(source_type, TypeFacts::NE_UNDEFINED);
            }
        }
        if is_object_literal_expression(target) {
            return self.check_object_literal_assignment(target, source_type, right_is_this);
        }
        if is_array_literal_expression(target) {
            return self.check_array_literal_assignment(target, source_type, check_mode);
        }
        self.check_reference_assignment(target, source_type, check_mode)
    }

    // Go: checker/checker.go:12824 checkObjectLiteralAssignment
    pub fn check_object_literal_assignment(
        &mut self,
        node: Node,
        source_type: TypeId,
        right_is_this: bool,
    ) -> TypeId {
        let properties = node.property_list();
        if self.strict_null_checks && properties.nodes().len() == 0 {
            return self.check_non_null_type(source_type, node);
        }
        for i in 0..properties.nodes().len() {
            self.check_object_literal_destructuring_property_assignment(
                node,
                source_type,
                i as i32,
                properties,
                right_is_this,
            );
        }
        source_type
    }

    // Note: If property cannot be a SpreadAssignment, then allProperties does not need to be provided
    // Go: checker/checker.go:12836 checkObjectLiteralDestructuringPropertyAssignment
    pub fn check_object_literal_destructuring_property_assignment(
        &mut self,
        node: Node,
        object_literal_type: TypeId,
        property_index: i32,
        all_properties: NodeList,
        right_is_this: bool,
    ) -> TypeId {
        let properties = node.properties();
        let property = properties.get(property_index as usize);
        if is_property_assignment(property) || is_shorthand_property_assignment(property) {
            let name = property.name();

            if name.is_some() && is_private_identifier(name) {
                self.grammar_error_on_node(
                    name,
                    diag::Private_identifiers_cannot_be_used_in_destructuring_patterns,
                    args![],
                );
            }

            let expr_type = self.get_literal_type_from_property_name(name);
            if self.is_type_usable_as_property_name(expr_type) {
                let text = self.get_property_name_from_type(expr_type);
                let prop = self.get_property_of_type(object_literal_type, &text);
                if prop.is_some() {
                    self.mark_property_as_referenced(prop, property, right_is_this);
                    self.check_property_accessibility(
                        property,
                        false, /*isSuper*/
                        true,  /*writing*/
                        object_literal_type,
                        prop,
                    );
                }
            }
            let access_flags = AccessFlags::EXPRESSION_POSITION
                | if self.has_default_value(property) {
                    AccessFlags::ALLOW_MISSING
                } else {
                    AccessFlags::NONE
                };
            let element_type = self.get_indexed_access_type_ex(
                object_literal_type,
                expr_type,
                access_flags,
                name,
                None,
            );
            let t = self.get_flow_type_of_destructuring(property, element_type);
            let mut expr = property;
            if is_property_assignment(property) {
                expr = property.initializer();
            }
            return self.check_destructuring_assignment(expr, t, CheckMode::NORMAL, false);
        }
        if is_spread_assignment(property) {
            if (property_index as usize) < properties.len() - 1 {
                self.error(
                    property,
                    diag::A_rest_element_must_be_last_in_a_destructuring_pattern,
                    args![],
                );
                return TypeId::NIL;
            }
            if self.language_version < LANGUAGE_FEATURE_MINIMUM_TARGET.object_spread_rest {
                self.check_external_emit_helpers(property, ExternalEmitHelpers::REST);
            }
            let mut non_rest_names: Vec<Node> = Vec::new();
            if !all_properties.is_nil() {
                for other_property in all_properties.nodes() {
                    if !is_spread_assignment(other_property) {
                        non_rest_names.push(other_property.name());
                    }
                }
            }
            let object_literal_symbol = self.ty(object_literal_type).symbol;
            let t = self.get_rest_type(object_literal_type, &non_rest_names, object_literal_symbol);
            self.check_grammar_for_disallowed_trailing_comma(
                all_properties,
                diag::A_rest_parameter_or_binding_pattern_may_not_have_a_trailing_comma,
            );
            return self.check_destructuring_assignment(
                property.expression(),
                t,
                CheckMode::NORMAL,
                false,
            );
        }
        self.error(property, diag::Property_assignment_expected, args![]);
        TypeId::NIL
    }

    // Go: checker/checker.go:12887 checkArrayLiteralAssignment
    pub fn check_array_literal_assignment(
        &mut self,
        node: Node,
        source_type: TypeId,
        check_mode: CheckMode,
    ) -> TypeId {
        let elements = node.elements();
        // This elementType will be used if the specific property corresponding to this index is not
        // present (aka the tuple element property). This call also checks that the parentType is in
        // fact an iterable or array (depending on target language).
        let undefined_type = self.undefined_type;
        let checked = self.check_iterated_type_or_element_type(
            IterationUse::DESTRUCTURING | IterationUse::POSSIBLY_OUT_OF_BOUNDS,
            source_type,
            undefined_type,
            node,
        );
        let possibly_out_of_bounds_type = if checked.is_some() {
            checked
        } else {
            self.error_type
        };
        let mut in_bounds_type =
            if self.compiler_options.no_unchecked_indexed_access == Tristate::True {
                TypeId::NIL
            } else {
                possibly_out_of_bounds_type
            };
        for i in 0..elements.len() {
            let mut t = possibly_out_of_bounds_type;
            if elements.get(i).kind() == SyntaxKind::SpreadElement {
                if in_bounds_type.is_nil() {
                    let checked = self.check_iterated_type_or_element_type(
                        IterationUse::DESTRUCTURING,
                        source_type,
                        undefined_type,
                        node,
                    );
                    in_bounds_type = if checked.is_some() {
                        checked
                    } else {
                        self.error_type
                    };
                }
                t = in_bounds_type;
            }
            self.check_array_literal_destructuring_element_assignment(
                node,
                source_type,
                i as i32,
                t,
                check_mode,
            );
        }
        source_type
    }

    // Go: checker/checker.go:12907 checkArrayLiteralDestructuringElementAssignment
    pub fn check_array_literal_destructuring_element_assignment(
        &mut self,
        node: Node,
        source_type: TypeId,
        element_index: i32,
        element_type: TypeId,
        check_mode: CheckMode,
    ) -> TypeId {
        let elements = node.element_list();
        let element = elements.nodes().get(element_index as usize);
        if !is_omitted_expression(element) {
            if !is_spread_element(element) {
                let index_type =
                    self.get_number_literal_type(crate::jsnum::Number::new(element_index as f64));
                if self.is_array_like_type(source_type) {
                    // We create a synthetic expression so that getIndexedAccessType doesn't get confused
                    // when the element is a SyntaxKind.ElementAccessExpression.
                    let access_flags = AccessFlags::EXPRESSION_POSITION
                        | if self.has_default_value(element) {
                            AccessFlags::ALLOW_MISSING
                        } else {
                            AccessFlags::NONE
                        };
                    let synthetic =
                        self.create_synthetic_expression(element, index_type, false, Node::NIL);
                    let indexed = self.get_indexed_access_type_or_undefined(
                        source_type,
                        index_type,
                        access_flags,
                        synthetic,
                        None,
                    );
                    let element_type = if indexed.is_some() {
                        indexed
                    } else {
                        self.error_type
                    };
                    let mut assigned_type = element_type;
                    if self.has_default_value(element) {
                        assigned_type =
                            self.get_type_with_facts(element_type, TypeFacts::NE_UNDEFINED);
                    }
                    let t = self.get_flow_type_of_destructuring(element, assigned_type);
                    return self.check_destructuring_assignment(element, t, check_mode, false);
                }
                return self.check_destructuring_assignment(
                    element,
                    element_type,
                    check_mode,
                    false,
                );
            }
            if (element_index as usize) < elements.nodes().len() - 1 {
                self.error(
                    element,
                    diag::A_rest_element_must_be_last_in_a_destructuring_pattern,
                    args![],
                );
            } else {
                let rest_expression = element.expression();
                if is_binary_expression(rest_expression)
                    && rest_expression.operator_token().kind() == SyntaxKind::EqualsToken
                {
                    self.error(
                        rest_expression.operator_token(),
                        diag::A_rest_element_cannot_have_an_initializer,
                        args![],
                    );
                } else {
                    self.check_grammar_for_disallowed_trailing_comma(
                        elements,
                        diag::A_rest_parameter_or_binding_pattern_may_not_have_a_trailing_comma,
                    );
                    let t;
                    if self.every_type(source_type, &mut |c: &mut Checker, t: TypeId| {
                        c.is_tuple_type(t)
                    }) {
                        t = self.map_type(source_type, &mut |c: &mut Checker, t: TypeId| {
                            c.slice_tuple_type(t, element_index, 0)
                        });
                    } else {
                        t = self.create_array_type(element_type);
                    }
                    return self.check_destructuring_assignment(
                        rest_expression,
                        t,
                        check_mode,
                        false,
                    );
                }
            }
        }
        TypeId::NIL
    }

    // Go: checker/checker.go:12948 checkReferenceAssignment
    pub fn check_reference_assignment(
        &mut self,
        target: Node,
        source_type: TypeId,
        check_mode: CheckMode,
    ) -> TypeId {
        let target_type = self.check_expression_ex(target, check_mode);
        let message = if is_spread_assignment(target.parent()) {
            diag::The_target_of_an_object_rest_assignment_must_be_a_variable_or_a_property_access
        } else {
            diag::The_left_hand_side_of_an_assignment_expression_must_be_a_variable_or_a_property_access
        };
        let optional_message = if is_spread_assignment(target.parent()) {
            diag::The_target_of_an_object_rest_assignment_may_not_be_an_optional_property_access
        } else {
            diag::The_left_hand_side_of_an_assignment_expression_may_not_be_an_optional_property_access
        };
        if self.check_reference_expression(target, message, optional_message) {
            self.check_type_assignable_to_and_optionally_elaborate(
                source_type,
                target_type,
                target,
                target,
                None,
                None,
            );
        }
        source_type
    }

    // Go: checker/checker.go:12962 reportOperatorError
    pub fn report_operator_error(
        &mut self,
        left_type: TypeId,
        operator: SyntaxKind,
        right_type: TypeId,
        error_node: Node,
        mut is_related: Option<&mut dyn FnMut(&mut Checker, TypeId, TypeId) -> bool>,
    ) {
        let mut would_work_with_await = false;
        if let Some(is_related) = is_related.as_deref_mut() {
            let awaited_left_type = self.get_awaited_type_no_alias(left_type);
            let awaited_right_type = self.get_awaited_type_no_alias(right_type);
            would_work_with_await = !(awaited_left_type == left_type
                && awaited_right_type == right_type)
                && awaited_left_type.is_some()
                && awaited_right_type.is_some()
                && is_related(self, awaited_left_type, awaited_right_type);
        }
        let mut effective_left = left_type;
        let mut effective_right = right_type;
        if !would_work_with_await {
            if let Some(is_related) = is_related.as_deref_mut() {
                (effective_left, effective_right) =
                    self.get_base_types_if_unrelated(left_type, right_type, is_related);
            }
        }
        let (left_str, right_str) =
            self.get_type_names_for_error_display(effective_left, effective_right);
        match operator {
            SyntaxKind::EqualsEqualsEqualsToken
            | SyntaxKind::EqualsEqualsToken
            | SyntaxKind::ExclamationEqualsEqualsToken
            | SyntaxKind::ExclamationEqualsToken => {
                self.error_and_maybe_suggest_await(
                    error_node,
                    would_work_with_await,
                    diag::This_comparison_appears_to_be_unintentional_because_the_types_0_and_1_have_no_overlap,
                    args![left_str, right_str],
                );
            }
            _ => {
                self.error_and_maybe_suggest_await(
                    error_node,
                    would_work_with_await,
                    diag::Operator_0_cannot_be_applied_to_types_1_and_2,
                    args![token_to_string(operator), left_str, right_str],
                );
            }
        }
    }

    // Go: checker/checker.go:12983 reportOperatorErrorUnless
    pub fn report_operator_error_unless(
        &mut self,
        left_type: TypeId,
        operator: SyntaxKind,
        right_type: TypeId,
        error_node: Node,
        types_are_compatible: &mut dyn FnMut(&mut Checker, TypeId, TypeId) -> bool,
    ) {
        if !types_are_compatible(self, left_type, right_type) {
            self.report_operator_error(
                left_type,
                operator,
                right_type,
                error_node,
                Some(types_are_compatible),
            );
        }
    }

    // Go: checker/checker.go:12989 getBaseTypesIfUnrelated
    pub fn get_base_types_if_unrelated(
        &mut self,
        left_type: TypeId,
        right_type: TypeId,
        is_related: &mut dyn FnMut(&mut Checker, TypeId, TypeId) -> bool,
    ) -> (TypeId, TypeId) {
        let mut effective_left = left_type;
        let mut effective_right = right_type;
        let left_base = self.get_base_type_of_literal_type(left_type);
        let right_base = self.get_base_type_of_literal_type(right_type);
        if !is_related(self, left_base, right_base) {
            effective_left = left_base;
            effective_right = right_base;
        }
        (effective_left, effective_right)
    }

    // Go: checker/checker.go:13001 checkAssignmentOperator
    pub fn check_assignment_operator(
        &mut self,
        left: Node,
        operator: SyntaxKind,
        right: Node,
        left_type: TypeId,
        right_type: TypeId,
    ) {
        let mut left_type = left_type;
        if is_assignment_operator(operator) {
            // We ignore assignments of undefined to CommonJS exports when there are multiple assignment declarations
            if is_declaration_node(left.parent())
                && get_assignment_declaration_kind(left.parent())
                    == JSDeclarationKind::EXPORTS_PROPERTY
            {
                let symbol = self.symbol_node_links.get(left).resolved_symbol;
                if symbol.is_some()
                    && self.sym(symbol).declarations.len() > 1
                    && self.ty(right_type).flags.intersects(TypeFlags::UNDEFINED)
                {
                    return;
                }
            }
            // getters can be a subtype of setters, so to check for assignability we use the setter's type instead
            if is_compound_assignment(operator) && is_property_access_expression(left) {
                left_type = self.check_property_access_expression(
                    left,
                    CheckMode::NORMAL,
                    true, /*writeOnly*/
                );
            }
            if self.check_reference_expression(
                left,
                diag::The_left_hand_side_of_an_assignment_expression_must_be_a_variable_or_a_property_access,
                diag::The_left_hand_side_of_an_assignment_expression_may_not_be_an_optional_property_access,
            ) {
                let mut head_message: Option<&'static Message> = None;
                if self.exact_optional_property_types
                    && is_property_access_expression(left)
                    && self.maybe_type_of_kind(right_type, TypeFlags::UNDEFINED)
                {
                    let expr_type = self.get_type_of_expression(left.expression());
                    let target = self.get_type_of_property_of_type(expr_type, left.name().text());
                    if self.is_exact_optional_property_mismatch(right_type, target) {
                        head_message = Some(diag::Type_0_is_not_assignable_to_type_1_with_exactOptionalPropertyTypes_Colon_true_Consider_adding_undefined_to_the_type_of_the_target);
                    }
                }
                // to avoid cascading errors check assignability only if 'isReference' check succeeded and no errors were reported
                self.check_type_assignable_to_and_optionally_elaborate(right_type, left_type, left, right, head_message, None);
            }
        }
    }

    // Go: checker/checker.go:13027 bothAreBigIntLike
    pub fn both_are_big_int_like(&mut self, left: TypeId, right: TypeId) -> bool {
        self.is_type_assignable_to_kind(left, TypeFlags::BIG_INT_LIKE)
            && self.is_type_assignable_to_kind(right, TypeFlags::BIG_INT_LIKE)
    }

    // Go: checker/checker.go:13031 getSuggestedBooleanOperator
    pub fn get_suggested_boolean_operator(&self, operator: SyntaxKind) -> SyntaxKind {
        match operator {
            SyntaxKind::BarToken | SyntaxKind::BarEqualsToken => SyntaxKind::BarBarToken,
            SyntaxKind::CaretToken | SyntaxKind::CaretEqualsToken => {
                SyntaxKind::ExclamationEqualsEqualsToken
            }
            SyntaxKind::AmpersandToken | SyntaxKind::AmpersandEqualsToken => {
                SyntaxKind::AmpersandAmpersandToken
            }
            _ => SyntaxKind::Unknown,
        }
    }

    // Go: checker/checker.go:13043 checkArithmeticOperandType
    pub fn check_arithmetic_operand_type(
        &mut self,
        operand: Node,
        t: TypeId,
        diagnostic: &'static Message,
        is_await_valid: bool,
    ) -> bool {
        let number_or_big_int_type = self.number_or_big_int_type;
        if !self.is_type_assignable_to(t, number_or_big_int_type) {
            let mut awaited_type = TypeId::NIL;
            if is_await_valid {
                awaited_type = self.get_awaited_type_of_promise(t);
            }
            let maybe_missing_await = awaited_type.is_some()
                && self.is_type_assignable_to(awaited_type, number_or_big_int_type);
            self.error_and_maybe_suggest_await(operand, maybe_missing_await, diagnostic, args![]);
            return false;
        }
        true
    }

    // Return true if there was no error, false if there was an error.
    // Go: checker/checker.go:13056 checkForDisallowedESSymbolOperand
    pub fn check_for_disallowed_es_symbol_operand(
        &mut self,
        left: Node,
        right: Node,
        left_type: TypeId,
        right_type: TypeId,
        operator: SyntaxKind,
    ) -> bool {
        let mut offending_symbol_operand = Node::NIL;
        if self.maybe_type_of_kind_considering_base_constraint(left_type, TypeFlags::ES_SYMBOL_LIKE)
        {
            offending_symbol_operand = left;
        } else if self
            .maybe_type_of_kind_considering_base_constraint(right_type, TypeFlags::ES_SYMBOL_LIKE)
        {
            offending_symbol_operand = right;
        }
        if offending_symbol_operand.is_some() {
            self.error(
                offending_symbol_operand,
                diag::The_0_operator_cannot_be_applied_to_type_symbol,
                args![token_to_string(operator)],
            );
            return false;
        }
        true
    }

    // Go: checker/checker.go:13071 checkNaNEquality
    pub fn check_na_n_equality(
        &mut self,
        error_node: Node,
        operator: SyntaxKind,
        left: Node,
        right: Node,
    ) {
        let is_left_na_n = self.is_global_na_n(skip_parentheses(left));
        let is_right_na_n = self.is_global_na_n(skip_parentheses(right));
        if is_left_na_n || is_right_na_n {
            let token = if operator == SyntaxKind::EqualsEqualsEqualsToken
                || operator == SyntaxKind::EqualsEqualsToken
            {
                SyntaxKind::FalseKeyword
            } else {
                SyntaxKind::TrueKeyword
            };
            // PORT: Go `c.error` adds the diagnostic, then mutates it below.
            // Build it, finish it, then add it (the same steps as `c.error`).
            let mut err = new_diagnostic_for_node(
                error_node,
                diag::This_condition_will_always_return_0,
                args![token_to_string(token)],
            );
            if is_left_na_n && is_right_na_n {
                self.add_diagnostic(err);
                return;
            }
            let mut operator_string = String::new();
            if operator == SyntaxKind::ExclamationEqualsEqualsToken
                || operator == SyntaxKind::ExclamationEqualsToken
            {
                operator_string = token_to_string(SyntaxKind::ExclamationToken).to_string();
            }
            let mut location = left;
            if is_left_na_n {
                location = right;
            }
            let expression = skip_parentheses(location);
            let mut entity_name = "...".to_string();
            if is_entity_name_expression(expression) {
                // PORT: checker `entityNameToString(name)` is
                // `ast.EntityNameToString(name, scanner.GetTextOfNode)`.
                entity_name =
                    crate::ast::entity_name_to_string(expression, Some(&get_text_of_node));
            }
            let suggestion = operator_string + "Number.isNaN(" + &entity_name + ")";
            err.add_related_info(Some(create_diagnostic_for_node(
                location,
                diag::Did_you_mean_0,
                args![suggestion],
            )));
            self.add_diagnostic(err);
        }
    }

    // Go: checker/checker.go:13097 isGlobalNaN
    pub fn is_global_na_n(&mut self, expr: Node) -> bool {
        if is_identifier(expr) && expr.text() == "NaN" {
            let global_na_n_symbol = (self.get_global_na_n_symbol_or_nil.clone())(self);
            return global_na_n_symbol.is_some()
                && global_na_n_symbol == self.get_resolved_symbol(expr);
        }
        false
    }

    // Go: checker/checker.go:13105 isTypeEqualityComparableTo
    pub fn is_type_equality_comparable_to(&mut self, source: TypeId, target: TypeId) -> bool {
        self.ty(target).flags.intersects(TypeFlags::NULLABLE)
            || self.is_type_comparable_to(source, target)
    }

    // Go: checker/checker.go:13109 checkTruthinessOfType
    pub fn check_truthiness_of_type(&mut self, t: TypeId, node: Node) -> TypeId {
        if self.ty(t).flags.intersects(TypeFlags::VOID) {
            self.error(
                node,
                diag::An_expression_of_type_void_cannot_be_tested_for_truthiness,
                args![],
            );
            return t;
        }
        let semantics = self.get_syntactic_truthy_semantics(node);
        if semantics != PredicateSemantics::SOMETIMES {
            self.error(
                node,
                if semantics == PredicateSemantics::ALWAYS {
                    diag::This_kind_of_expression_is_always_truthy
                } else {
                    diag::This_kind_of_expression_is_always_falsy
                },
                args![],
            );
        }
        t
    }

    // PORT: Go `type PredicateSemantics` and its consts live in `flags.rs`.

    // Go: checker/checker.go:13130 getSyntacticTruthySemantics
    pub fn get_syntactic_truthy_semantics(&mut self, node: Node) -> PredicateSemantics {
        let node = skip_outer_expressions(node, OuterExpressionKinds::OEK_ALL);
        match node.kind() {
            SyntaxKind::NumericLiteral => {
                // Allow `while(0)` or `while(1)`
                if node.text() == "0" || node.text() == "1" {
                    return PredicateSemantics::SOMETIMES;
                }
                return PredicateSemantics::ALWAYS;
            }
            SyntaxKind::ArrayLiteralExpression
            | SyntaxKind::ArrowFunction
            | SyntaxKind::BigIntLiteral
            | SyntaxKind::ClassExpression
            | SyntaxKind::FunctionExpression
            | SyntaxKind::JsxElement
            | SyntaxKind::JsxSelfClosingElement
            | SyntaxKind::ObjectLiteralExpression
            | SyntaxKind::RegularExpressionLiteral => {
                return PredicateSemantics::ALWAYS;
            }
            SyntaxKind::VoidExpression | SyntaxKind::NullKeyword => {
                return PredicateSemantics::NEVER;
            }
            SyntaxKind::NoSubstitutionTemplateLiteral | SyntaxKind::StringLiteral => {
                if node.text() != "" {
                    return PredicateSemantics::ALWAYS;
                }
                return PredicateSemantics::NEVER;
            }
            SyntaxKind::ConditionalExpression => {
                return self.get_syntactic_truthy_semantics(node.when_true())
                    | self.get_syntactic_truthy_semantics(node.when_false());
            }
            SyntaxKind::Identifier => {
                if self.get_resolved_symbol(node) == self.undefined_symbol {
                    return PredicateSemantics::NEVER;
                }
            }
            _ => {}
        }
        PredicateSemantics::SOMETIMES
    }

    // Go: checker/checker.go:13159 checkNullishCoalesceOperands
    pub fn check_nullish_coalesce_operands(&mut self, left: Node, right: Node) {
        if is_binary_expression(left.parent().parent()) {
            let grandparent_left = left.parent().parent().left();
            let grandparent_operator_token = left.parent().parent().operator_token();
            if is_binary_expression(grandparent_left)
                && grandparent_operator_token.kind() == SyntaxKind::BarBarToken
            {
                self.grammar_error_on_node(
                    grandparent_left,
                    diag::X_0_and_1_operations_cannot_be_mixed_without_parentheses,
                    args![
                        token_to_string(SyntaxKind::QuestionQuestionToken),
                        token_to_string(grandparent_operator_token.kind())
                    ],
                );
            }
        } else if is_binary_expression(left) {
            let operator_token = left.operator_token();
            if operator_token.kind() == SyntaxKind::BarBarToken
                || operator_token.kind() == SyntaxKind::AmpersandAmpersandToken
            {
                self.grammar_error_on_node(
                    left,
                    diag::X_0_and_1_operations_cannot_be_mixed_without_parentheses,
                    args![
                        token_to_string(operator_token.kind()),
                        token_to_string(SyntaxKind::QuestionQuestionToken)
                    ],
                );
            }
        } else if is_binary_expression(right) {
            let operator_token = right.operator_token();
            if operator_token.kind() == SyntaxKind::AmpersandAmpersandToken {
                self.grammar_error_on_node(
                    right,
                    diag::X_0_and_1_operations_cannot_be_mixed_without_parentheses,
                    args![
                        token_to_string(SyntaxKind::QuestionQuestionToken),
                        token_to_string(operator_token.kind())
                    ],
                );
            }
        }
        self.check_nullish_coalesce_operand_left(left);
    }

    // Go: checker/checker.go:13180 checkNullishCoalesceOperandLeft
    pub fn check_nullish_coalesce_operand_left(&mut self, left: Node) {
        let left_target = skip_outer_expressions(left, OuterExpressionKinds::OEK_ALL);
        let nullish_semantics = self.get_syntactic_nullishness_semantics(left_target);
        if nullish_semantics != PredicateSemantics::SOMETIMES {
            if nullish_semantics == PredicateSemantics::ALWAYS {
                self.error(
                    left_target,
                    diag::This_expression_is_always_nullish,
                    args![],
                );
            } else {
                self.error(
                    left_target,
                    diag::Right_operand_of_is_unreachable_because_the_left_operand_is_never_nullish,
                    args![],
                );
            }
        }
    }

    // Go: checker/checker.go:13192 getSyntacticNullishnessSemantics
    pub fn get_syntactic_nullishness_semantics(&mut self, node: Node) -> PredicateSemantics {
        let node = skip_outer_expressions(node, OuterExpressionKinds::OEK_ALL);
        match node.kind() {
            SyntaxKind::AwaitExpression
            | SyntaxKind::CallExpression
            | SyntaxKind::TaggedTemplateExpression
            | SyntaxKind::ElementAccessExpression
            | SyntaxKind::MetaProperty
            | SyntaxKind::NewExpression
            | SyntaxKind::PropertyAccessExpression
            | SyntaxKind::YieldExpression
            | SyntaxKind::ThisKeyword => PredicateSemantics::SOMETIMES,
            SyntaxKind::BinaryExpression => {
                // List of operators that can produce null/undefined:
                // || ||= && &&= ?? ??=
                match node.operator_token().kind() {
                    SyntaxKind::BarBarToken
                    | SyntaxKind::BarBarEqualsToken
                    | SyntaxKind::AmpersandAmpersandToken
                    | SyntaxKind::AmpersandAmpersandEqualsToken => PredicateSemantics::SOMETIMES,
                    // For these operator kinds, the right operand is effectively controlling
                    SyntaxKind::CommaToken | SyntaxKind::EqualsToken => {
                        self.get_syntactic_nullishness_semantics(node.right())
                    }
                    // For nullish coalescing: result is the left operand when left is non-null,
                    // or the right operand when left is null/undefined. The nullishness of the
                    // result combines both paths: the left's non-null path contributes Never,
                    // and when left can be null, the right's semantics are also included.
                    SyntaxKind::QuestionQuestionToken | SyntaxKind::QuestionQuestionEqualsToken => {
                        let left_semantics = self.get_syntactic_nullishness_semantics(node.left());
                        // The non-null path (left is non-null): left branch taken, result has Never bit
                        let mut result = left_semantics & PredicateSemantics::NEVER;
                        // The null path (left is null/undefined): right branch taken, result inherits right's semantics
                        if left_semantics.intersects(PredicateSemantics::ALWAYS) {
                            result |= self.get_syntactic_nullishness_semantics(node.right());
                        }
                        result
                    }
                    _ => PredicateSemantics::NEVER,
                }
            }
            SyntaxKind::ConditionalExpression => {
                self.get_syntactic_nullishness_semantics(node.when_true())
                    | self.get_syntactic_nullishness_semantics(node.when_false())
            }
            SyntaxKind::NullKeyword => PredicateSemantics::ALWAYS,
            SyntaxKind::Identifier => {
                if self.get_resolved_symbol(node) == self.undefined_symbol {
                    return PredicateSemantics::ALWAYS;
                }
                PredicateSemantics::SOMETIMES
            }
            _ => PredicateSemantics::NEVER,
        }
    }

    // This is a *shallow* check: An expression is side-effect-free if the
    // evaluation of the expression *itself* cannot produce side effects.
    // For example, x++ / 3 is side-effect free because the / operator
    // does not have side effects.
    // The intent is to "smell test" an expression for correctness in positions where
    // its value is discarded (e.g. the left side of the comma operator).
    // Go: checker/checker.go:13255 isSideEffectFree
    pub fn is_side_effect_free(&self, node: Node) -> bool {
        let node = skip_parentheses(node);
        match node.kind() {
            SyntaxKind::Identifier
            | SyntaxKind::StringLiteral
            | SyntaxKind::RegularExpressionLiteral
            | SyntaxKind::TaggedTemplateExpression
            | SyntaxKind::TemplateExpression
            | SyntaxKind::NoSubstitutionTemplateLiteral
            | SyntaxKind::NumericLiteral
            | SyntaxKind::BigIntLiteral
            | SyntaxKind::TrueKeyword
            | SyntaxKind::FalseKeyword
            | SyntaxKind::NullKeyword
            | SyntaxKind::UndefinedKeyword
            | SyntaxKind::FunctionExpression
            | SyntaxKind::ClassExpression
            | SyntaxKind::ArrowFunction
            | SyntaxKind::ArrayLiteralExpression
            | SyntaxKind::ObjectLiteralExpression
            | SyntaxKind::TypeOfExpression
            | SyntaxKind::NonNullExpression
            | SyntaxKind::JsxSelfClosingElement
            | SyntaxKind::JsxElement => true,
            SyntaxKind::ConditionalExpression => {
                self.is_side_effect_free(node.when_true())
                    && self.is_side_effect_free(node.when_false())
            }
            SyntaxKind::BinaryExpression => {
                if is_assignment_operator(node.operator_token().kind()) {
                    return false;
                }
                self.is_side_effect_free(node.left()) && self.is_side_effect_free(node.right())
            }
            SyntaxKind::PrefixUnaryExpression => {
                // Unary operators ~, !, +, and - have no side effects.
                // The rest do.
                match node.operator() {
                    SyntaxKind::ExclamationToken
                    | SyntaxKind::PlusToken
                    | SyntaxKind::MinusToken
                    | SyntaxKind::TildeToken => true,
                    _ => false,
                }
            }
            _ => false,
        }
    }

    // Return true for "indirect calls", (i.e. `(0, x.f)(...)` or `(0, eval)(...)`), which prevents passing `this`.
    // Go: checker/checker.go:13283 isIndirectCall
    pub fn is_indirect_call(&self, node: Node) -> bool {
        let left = node.left();
        let right = node.right();
        is_parenthesized_expression(node.parent())
            && is_numeric_literal(left)
            && left.text() == "0"
            && (is_call_expression(node.parent().parent())
                && node.parent().parent().expression() == node.parent()
                || is_tagged_template_expression(node.parent().parent()))
            && (is_access_expression(right) || is_identifier(right) && right.text() == "eval")
    }

    // Go: checker/checker.go:13291 checkInstanceOfExpression
    pub fn check_instance_of_expression(
        &mut self,
        left: Node,
        right: Node,
        left_type: TypeId,
        right_type: TypeId,
        check_mode: CheckMode,
    ) -> TypeId {
        if left_type == self.silent_never_type || right_type == self.silent_never_type {
            return self.silent_never_type;
        }
        // TypeScript 1.0 spec (April 2014): 4.15.4
        // The instanceof operator requires the left operand to be of type Any, an object type, or a type parameter type,
        // and the right operand to be of type Any, a subtype of the 'Function' interface type, or have a call or construct signature.
        // The result is always of the Boolean primitive type.
        // NOTE: do not raise error if leftType is unknown as related error was already reported
        if !self.is_type_any(left_type)
            && self.all_types_assignable_to_kind(left_type, TypeFlags::PRIMITIVE)
        {
            self.error(
                left,
                diag::The_left_hand_side_of_an_instanceof_expression_must_be_of_type_any_an_object_type_or_a_type_parameter,
                args![],
            );
        }
        let signature = self.get_resolved_signature(
            left.parent(),
            None, /*candidatesOutArray*/
            check_mode,
        );
        if signature == self.resolving_signature {
            // CheckMode.SkipGenericFunctions is enabled and this is a call to a generic function that
            // returns a function type. We defer checking and return silentNeverType.
            return self.silent_never_type;
        }
        // If rightType has a `[Symbol.hasInstance]` method that is not `(value: unknown) => boolean`, we
        // must check the expression as if it were a call to `right[Symbol.hasInstance](left)`. The call to
        // `getResolvedSignature`, below, will check that leftType is assignable to the type of the first
        // parameter.
        let return_type = self.get_return_type_of_signature(signature);
        // We also verify that the return type of the `[Symbol.hasInstance]` method is assignable to
        // `boolean`. According to the spec, the runtime will actually perform `ToBoolean` on the result,
        // but this is more type-safe.
        let boolean_type = self.boolean_type;
        self.check_type_assignable_to(
            return_type,
            boolean_type,
            right,
            Some(diag::An_object_s_Symbol_hasInstance_method_must_return_a_boolean_value_for_it_to_be_used_on_the_right_hand_side_of_an_instanceof_expression),
        );
        self.boolean_type
    }
}
