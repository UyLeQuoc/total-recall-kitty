/// Kitty (KT1, ADR-0062): a group pot that nobody holds.
///
/// Each member joins with one signature: an app-bound allowance (app type `KITTY`) whose spender is
/// the pot's keeper and whose rate limit is the most that member will put in per window. The money
/// stays in the member's own address balance until the keeper pulls a share.
///
/// Sui enforces the per-window cap, the start and expiry, the spender and revocation. The pot adds:
/// - membership (one allowance per member, matched by `(funder, name)`);
/// - spending by quorum, and rule changes by the same vote;
/// - auto-ok spends up to a cap the group voted for;
/// - a pro-rata refund at close;
/// - an event for every money move.
///
/// Permit guards: `internal::permit<KITTY>()` is minted only in `join` (the proposal's funder is the
/// sender), `contribute` (the native module checks the spender, the pot checks membership) and never
/// elsewhere.
///
/// Delegates (KT4, version 2, ADR-0067): a member may name one agent that proposes spends and approves
/// them for that member, up to a cap. Above the cap, or for rules and closing, the member decides.
/// Delegates live in dynamic fields on the pot, since an upgrade can't change `Pot`'s layout.
module kitty::pot;

use std::internal;
use std::string::String;
use sui::allowance::{Self, Allowance, AllowanceCap, AllowanceProposal, AllowanceWithdrawal};
use sui::balance::{Self, Balance};
use sui::clock::Clock;
use sui::dynamic_field as df;
use sui::event;
use sui::table::{Self, Table};
use sui::vec_map::{Self, VecMap};
use sui::vec_set::{Self, VecSet};

/// Bumped on every upgrade that changes object semantics; pots migrate forward with `migrate`.
const VERSION: u64 = 2;
const MAX_MEMBERS: u64 = 20;

#[error(code = 1)]
const ENotMember: vector<u8> = "Only an active member can do this";
#[error(code = 2)]
const EAlreadyMember: vector<u8> = "Already a member of this pot";
#[error(code = 3)]
const EWrongAllowance: vector<u8> = "The allowance isn't this member's allowance for this pot";
#[error(code = 4)]
const EWrongSpender: vector<u8> = "The allowance's spender must be the pot's keeper";
#[error(code = 5)]
const ENotKeeper: vector<u8> = "Only the keeper pulls contributions";
#[error(code = 6)]
const EClosed: vector<u8> = "The pot is closed";
#[error(code = 7)]
const EBadQuorum: vector<u8> = "Quorum must be at least 1";
#[error(code = 8)]
const ENoProposal: vector<u8> = "No such proposal";
#[error(code = 9)]
const EAlreadyApproved: vector<u8> = "Already approved";
#[error(code = 10)]
const EUnderQuorum: vector<u8> = "Not enough approvals yet";
#[error(code = 11)]
const EOverAutoCap: vector<u8> = "Above the auto-ok cap: propose it and get the group's approvals";
#[error(code = 12)]
const EOverBalance: vector<u8> = "The pot doesn't hold that much";
#[error(code = 13)]
const EExecuted: vector<u8> = "Already executed";
#[error(code = 14)]
const ETooEarly: vector<u8> = "Only a vote can close the pot before its deadline";
#[error(code = 15)]
const EFull: vector<u8> = "The pot has the most members it can hold";
#[error(code = 16)]
const EZeroAmount: vector<u8> = "Amount must be greater than zero";
#[error(code = 17)]
const EWrongVersion: vector<u8> = "Object version doesn't match the package; migrate it";
#[error(code = 18)]
const ENotUpgrade: vector<u8> = "Object is already at the current version";
#[error(code = 19)]
const EOverDelegateCap: vector<u8> = "Above this agent's cap: the member approves it themselves";
#[error(code = 20)]
const ENotDelegate: vector<u8> = "Only the member's current delegate can do this";
#[error(code = 21)]
const EDelegateSpendOnly: vector<u8> = "A delegate acts on spends only, never on rules or closing";

/// The app type allowances are bound to. Never instantiated: only its permit is minted, here.
public struct KITTY has drop {}

public struct Member has drop, store {
    /// The allowance's name; with the member's address it identifies the allowance.
    allowance_name: String,
    contributed: u64,
    active: bool,
}

public enum Action has copy, drop, store {
    Spend { payee: address, amount: u64, memo: String },
    SetAutoOkCap { cap: u64 },
    Close,
}

public struct Proposal has drop, store {
    action: Action,
    proposer: address,
    approvals: VecSet<address>,
    executed: bool,
}

/// Shared. The group's money while it's pooled, and the rules for spending it.
public struct Pot<phantom C> has key {
    id: UID,
    name: String,
    goal: u64,
    deadline_ms: u64,
    keeper: address,
    quorum: u64,
    auto_ok_cap: u64,
    members: VecMap<address, Member>,
    balance: Balance<C>,
    proposals: Table<u64, Proposal>,
    next_proposal: u64,
    total_in: u64,
    total_out: u64,
    closed: bool,
    version: u64,
}

/// The dynamic-field key of a member's delegate on the pot (version 2).
public struct DelegateKey has copy, drop, store { member: address }

/// An agent that proposes and approves spends for one member, up to `approve_cap`.
public struct Delegate has drop, store { agent: address, approve_cap: u64 }

// === Events ===

public struct PotCreated has copy, drop {
    pot: ID,
    name: String,
    goal: u64,
    deadline_ms: u64,
    keeper: address,
    quorum: u64,
    auto_ok_cap: u64,
}

public struct Joined has copy, drop { pot: ID, member: address, allowance_name: String }

public struct Contributed has copy, drop { pot: ID, member: address, amount: u64, total_in: u64 }

public struct Proposed has copy, drop { pot: ID, proposal: u64, proposer: address, action: Action }

public struct Approved has copy, drop { pot: ID, proposal: u64, member: address, approvals: u64 }

public struct Spent has copy, drop {
    pot: ID,
    payee: address,
    amount: u64,
    memo: String,
    /// `none` for an auto-ok spend.
    proposal: Option<u64>,
}

public struct RuleChanged has copy, drop { pot: ID, auto_ok_cap: u64, proposal: u64 }

public struct Left has copy, drop { pot: ID, member: address }

public struct Refunded has copy, drop { pot: ID, member: address, amount: u64 }

public struct Closed has copy, drop { pot: ID, refunded: u64, total_in: u64, total_out: u64 }

public struct DelegateSet has copy, drop { pot: ID, member: address, agent: address, approve_cap: u64 }

public struct DelegateRevoked has copy, drop { pot: ID, member: address, agent: address }

/// `approved`: the spend was within the cap, so it carries the member's approval.
public struct DelegateProposed has copy, drop {
    pot: ID,
    proposal: u64,
    member: address,
    agent: address,
    amount: u64,
    approved: bool,
}

public struct DelegateApproved has copy, drop {
    pot: ID,
    proposal: u64,
    member: address,
    agent: address,
    approvals: u64,
}

// === Create and join ===

/// Anyone: a new shared pot. The creator joins like everyone else, with `join`.
public fun create<C>(
    name: String,
    goal: u64,
    deadline_ms: u64,
    keeper: address,
    quorum: u64,
    auto_ok_cap: u64,
    ctx: &mut TxContext,
): ID {
    assert!(quorum >= 1, EBadQuorum);
    let pot = Pot<C> {
        id: object::new(ctx),
        name,
        goal,
        deadline_ms,
        keeper,
        quorum,
        auto_ok_cap,
        members: vec_map::empty(),
        balance: balance::zero(),
        proposals: table::new(ctx),
        next_proposal: 0,
        total_in: 0,
        total_out: 0,
        closed: false,
        version: VERSION,
    };
    let id = object::id(&pot);
    event::emit(PotCreated { pot: id, name, goal, deadline_ms, keeper, quorum, auto_ok_cap });
    transfer::share_object(pot);
    id
}

/// Member, in the same PTB as `allowance::propose_for_app<Balance<C>, KITTY>`: records the member
/// and issues the allowance. The proposal's spender must be the keeper.
public fun join<C>(pot: &mut Pot<C>, proposal: AllowanceProposal<Balance<C>>, ctx: &mut TxContext) {
    pot.assert_open();
    let settings = proposal.settings();
    let member = settings.funder();
    // Defense in depth: `propose_for_app` already makes the sender the funder.
    assert!(member == ctx.sender(), ENotMember);
    assert!(settings.spender() == option::some(pot.keeper), EWrongSpender);
    assert!(!pot.members.contains(&member), EAlreadyMember);
    assert!(pot.members.length() < MAX_MEMBERS, EFull);
    let allowance_name = *settings.name();
    pot.members.insert(member, Member { allowance_name, contributed: 0, active: true });
    event::emit(Joined { pot: object::id(pot), member, allowance_name });
    allowance::issue(proposal, allowance::settings_permit(internal::permit<KITTY>()), ctx);
}

// === Keeper ===

/// Keeper: pulls `withdrawal` from a member's address balance into the pot. The native module checks
/// the spender, the window, the cap and the expiry; the pot checks membership and the allowance.
public fun contribute<C>(
    pot: &mut Pot<C>,
    allowance: &mut Allowance<Balance<C>>,
    withdrawal: AllowanceWithdrawal<Balance<C>>,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    pot.assert_open();
    assert!(ctx.sender() == pot.keeper, ENotKeeper);
    let member = allowance.settings().funder();
    pot.assert_allowance(member, allowance);
    let permit = allowance::spend_permit(internal::permit<KITTY>());
    let pulled = allowance::app_balance_spend(allowance, permit, withdrawal, clock, ctx);
    let amount = pulled.value();
    assert!(amount > 0, EZeroAmount);
    pot.balance.join(pulled);
    pot.total_in = pot.total_in + amount;
    let m = pot.members.get_mut(&member);
    m.contributed = m.contributed + amount;
    event::emit(Contributed { pot: object::id(pot), member, amount, total_in: pot.total_in });
}

// === Members ===

public fun propose_spend<C>(
    pot: &mut Pot<C>,
    payee: address,
    amount: u64,
    memo: String,
    ctx: &mut TxContext,
): u64 {
    assert!(amount > 0, EZeroAmount);
    pot.propose(Action::Spend { payee, amount, memo }, ctx)
}

public fun propose_auto_ok_cap<C>(pot: &mut Pot<C>, cap: u64, ctx: &mut TxContext): u64 {
    pot.propose(Action::SetAutoOkCap { cap }, ctx)
}

public fun propose_close<C>(pot: &mut Pot<C>, ctx: &mut TxContext): u64 {
    pot.propose(Action::Close, ctx)
}

public fun approve<C>(pot: &mut Pot<C>, id: u64, ctx: &mut TxContext) {
    pot.assert_open();
    let member = ctx.sender();
    pot.assert_active(member);
    assert!(pot.proposals.contains(id), ENoProposal);
    let p = pot.proposals.borrow_mut(id);
    assert!(!p.executed, EExecuted);
    assert!(!p.approvals.contains(&member), EAlreadyApproved);
    p.approvals.insert(member);
    let approvals = p.approvals.length();
    event::emit(Approved { pot: object::id(pot), proposal: id, member, approvals });
}

/// Any active member, once the approvals of active members reach the quorum (capped at the number of
/// active members, so a group that shrank can still decide).
public fun execute<C>(pot: &mut Pot<C>, id: u64, ctx: &mut TxContext) {
    pot.assert_open();
    pot.assert_active(ctx.sender());
    pot.execute_inner(id);
}

fun execute_inner<C>(pot: &mut Pot<C>, id: u64) {
    assert!(pot.proposals.contains(id), ENoProposal);
    let needed = pot.quorum.min(pot.active_count());
    let have = pot.active_approvals(id);
    assert!(have >= needed, EUnderQuorum);
    let p = pot.proposals.borrow_mut(id);
    assert!(!p.executed, EExecuted);
    p.executed = true;
    match (p.action) {
        Action::Spend { payee, amount, memo } => pot.pay(payee, amount, memo, option::some(id)),
        Action::SetAutoOkCap { cap } => {
            pot.auto_ok_cap = cap;
            event::emit(RuleChanged { pot: object::id(pot), auto_ok_cap: cap, proposal: id });
        },
        Action::Close => pot.close_and_refund(),
    }
}

/// Any active member: a spend the group pre-approved by voting the auto-ok cap.
public fun spend_auto<C>(
    pot: &mut Pot<C>,
    payee: address,
    amount: u64,
    memo: String,
    ctx: &mut TxContext,
) {
    pot.assert_open();
    pot.assert_active(ctx.sender());
    assert!(amount > 0, EZeroAmount);
    assert!(amount <= pot.auto_ok_cap, EOverAutoCap);
    pot.pay(payee, amount, memo, option::none());
}

/// Member: revokes their allowance, so no more pulls. What they put in stays for spends and comes
/// back pro rata at close.
public fun leave<C>(
    pot: &mut Pot<C>,
    cap: AllowanceCap<Balance<C>>,
    allowance: Allowance<Balance<C>>,
    ctx: &mut TxContext,
) {
    pot.assert_version();
    let member = ctx.sender();
    pot.assert_active(member);
    pot.assert_allowance(member, &allowance);
    allowance::revoke(cap, allowance);
    pot.members.get_mut(&member).active = false;
    pot.drop_delegate(member);
    event::emit(Left { pot: object::id(pot), member });
}

/// Anyone, once the deadline has passed: refunds what's left, pro rata. Before it, only a vote closes.
public fun close_after_deadline<C>(pot: &mut Pot<C>, clock: &Clock) {
    pot.assert_open();
    assert!(clock.timestamp_ms() >= pot.deadline_ms, ETooEarly);
    pot.close_and_refund();
}

// === Delegates (version 2) ===

/// Member: names `agent` to propose spends and approve them for this member, up to `approve_cap`.
/// Replaces an earlier delegate.
public fun set_delegate<C>(pot: &mut Pot<C>, agent: address, approve_cap: u64, ctx: &mut TxContext) {
    pot.assert_open();
    let member = ctx.sender();
    pot.assert_active(member);
    pot.drop_delegate(member);
    df::add(&mut pot.id, DelegateKey { member }, Delegate { agent, approve_cap });
    event::emit(DelegateSet { pot: object::id(pot), member, agent, approve_cap });
}

/// Member: removes their delegate. From then on the agent's calls abort.
public fun revoke_delegate<C>(pot: &mut Pot<C>, ctx: &mut TxContext) {
    pot.assert_version();
    let member = ctx.sender();
    assert!(df::exists(&pot.id, DelegateKey { member }), ENotDelegate);
    pot.drop_delegate(member);
}

/// The member's delegate: proposes a spend for the member. Within the cap it carries the member's
/// approval, as a member's own proposal does; above it, it waits for the member.
public fun propose_as_delegate<C>(
    pot: &mut Pot<C>,
    member: address,
    payee: address,
    amount: u64,
    memo: String,
    ctx: &mut TxContext,
): u64 {
    pot.assert_open();
    assert!(amount > 0, EZeroAmount);
    let agent = ctx.sender();
    let cap = pot.delegate_cap(member, agent);
    let approved = amount <= cap;
    let id = pot.next_proposal;
    pot.next_proposal = id + 1;
    let action = Action::Spend { payee, amount, memo };
    let approvals = if (approved) vec_set::singleton(member) else vec_set::empty();
    pot.proposals.add(id, Proposal { action, proposer: member, approvals, executed: false });
    let pot_id = object::id(pot);
    event::emit(Proposed { pot: pot_id, proposal: id, proposer: member, action });
    event::emit(DelegateProposed { pot: pot_id, proposal: id, member, agent, amount, approved });
    id
}

/// The member's delegate: approves a spend for the member, up to the delegate's cap.
public fun approve_as_delegate<C>(pot: &mut Pot<C>, member: address, id: u64, ctx: &mut TxContext) {
    pot.assert_open();
    let agent = ctx.sender();
    let cap = pot.delegate_cap(member, agent);
    assert!(pot.proposals.contains(id), ENoProposal);
    let p = pot.proposals.borrow_mut(id);
    assert!(!p.executed, EExecuted);
    let amount = match (&p.action) {
        Action::Spend { amount, .. } => *amount,
        _ => abort EDelegateSpendOnly,
    };
    assert!(amount <= cap, EOverDelegateCap);
    assert!(!p.approvals.contains(&member), EAlreadyApproved);
    p.approvals.insert(member);
    let approvals = p.approvals.length();
    let pot_id = object::id(pot);
    event::emit(Approved { pot: pot_id, proposal: id, member, approvals });
    event::emit(DelegateApproved { pot: pot_id, proposal: id, member, agent, approvals });
}

/// The member's delegate, once a spend has its quorum: runs it, like `execute`.
public fun execute_as_delegate<C>(pot: &mut Pot<C>, member: address, id: u64, ctx: &mut TxContext) {
    pot.assert_open();
    let _cap = pot.delegate_cap(member, ctx.sender());
    assert!(pot.proposals.contains(id), ENoProposal);
    match (&pot.proposals.borrow(id).action) {
        Action::Spend { .. } => {},
        _ => abort EDelegateSpendOnly,
    };
    pot.execute_inner(id);
}

// === Upgrades ===

/// Moves a pot to this package's `VERSION`. Only ever forward, so anyone may call it.
public fun migrate<C>(pot: &mut Pot<C>) {
    assert!(pot.version < VERSION, ENotUpgrade);
    pot.version = VERSION;
}

// === Reads ===

public fun name<C>(pot: &Pot<C>): &String { &pot.name }

public fun goal<C>(pot: &Pot<C>): u64 { pot.goal }

public fun keeper<C>(pot: &Pot<C>): address { pot.keeper }

public fun quorum<C>(pot: &Pot<C>): u64 { pot.quorum }

public fun auto_ok_cap<C>(pot: &Pot<C>): u64 { pot.auto_ok_cap }

public fun balance_value<C>(pot: &Pot<C>): u64 { pot.balance.value() }

public fun total_in<C>(pot: &Pot<C>): u64 { pot.total_in }

public fun total_out<C>(pot: &Pot<C>): u64 { pot.total_out }

public fun is_closed<C>(pot: &Pot<C>): bool { pot.closed }

public fun version<C>(pot: &Pot<C>): u64 { pot.version }

public fun is_active<C>(pot: &Pot<C>, member: address): bool {
    pot.members.contains(&member) && pot.members.get(&member).active
}

public fun contributed<C>(pot: &Pot<C>, member: address): u64 {
    if (pot.members.contains(&member)) pot.members.get(&member).contributed else 0
}

public fun approvals<C>(pot: &Pot<C>, id: u64): u64 { pot.active_approvals(id) }

/// The member's delegate and its cap, if any.
public fun delegate<C>(pot: &Pot<C>, member: address): Option<address> {
    if (df::exists(&pot.id, DelegateKey { member })) {
        let d: &Delegate = df::borrow(&pot.id, DelegateKey { member });
        option::some(d.agent)
    } else option::none()
}

public fun delegate_approve_cap<C>(pot: &Pot<C>, member: address): u64 {
    if (df::exists(&pot.id, DelegateKey { member })) {
        let d: &Delegate = df::borrow(&pot.id, DelegateKey { member });
        d.approve_cap
    } else 0
}

// === Internal ===

fun propose<C>(pot: &mut Pot<C>, action: Action, ctx: &mut TxContext): u64 {
    pot.assert_open();
    let proposer = ctx.sender();
    pot.assert_active(proposer);
    let id = pot.next_proposal;
    pot.next_proposal = id + 1;
    // Proposing counts as the proposer's approval.
    pot.proposals.add(id, Proposal { action, proposer, approvals: vec_set::singleton(proposer), executed: false });
    event::emit(Proposed { pot: object::id(pot), proposal: id, proposer, action });
    id
}

fun pay<C>(pot: &mut Pot<C>, payee: address, amount: u64, memo: String, proposal: Option<u64>) {
    assert!(amount <= pot.balance.value(), EOverBalance);
    balance::send_funds(pot.balance.split(amount), payee);
    pot.total_out = pot.total_out + amount;
    event::emit(Spent { pot: object::id(pot), payee, amount, memo, proposal });
}

/// Pro rata by what each member put in; the last one with a share takes the rounding dust.
fun close_and_refund<C>(pot: &mut Pot<C>) {
    let remaining = pot.balance.value();
    let keys = pot.members.keys();
    let mut weight: u128 = 0;
    keys.do_ref!(|a| weight = weight + (pot.members.get(a).contributed as u128));
    let mut refunded = 0;
    let mut last = option::none<address>();
    keys.do_ref!(|a| if (pot.members.get(a).contributed > 0) last = option::some(*a));
    let pot_id = object::id(pot);
    keys.do_ref!(|a| {
        let c = pot.members.get(a).contributed as u128;
        if (c > 0 && weight > 0) {
            let share = if (last == option::some(*a)) remaining - refunded
            else ((remaining as u128) * c / weight) as u64;
            if (share > 0) {
                balance::send_funds(pot.balance.split(share), *a);
                event::emit(Refunded { pot: pot_id, member: *a, amount: share });
            };
            refunded = refunded + share;
        };
    });
    pot.closed = true;
    event::emit(Closed { pot: pot_id, refunded, total_in: pot.total_in, total_out: pot.total_out });
}

fun active_count<C>(pot: &Pot<C>): u64 {
    let mut n = 0;
    pot.members.keys().do_ref!(|a| if (pot.members.get(a).active) n = n + 1);
    n
}

fun active_approvals<C>(pot: &Pot<C>, id: u64): u64 {
    assert!(pot.proposals.contains(id), ENoProposal);
    let p = pot.proposals.borrow(id);
    let mut n = 0;
    p.approvals.keys().do_ref!(|a| if (pot.is_active(*a)) n = n + 1);
    n
}

/// `agent` is `member`'s current delegate, and the member is still in the pot: the agent's cap.
fun delegate_cap<C>(pot: &Pot<C>, member: address, agent: address): u64 {
    pot.assert_active(member);
    assert!(df::exists(&pot.id, DelegateKey { member }), ENotDelegate);
    let d: &Delegate = df::borrow(&pot.id, DelegateKey { member });
    assert!(d.agent == agent, ENotDelegate);
    d.approve_cap
}

fun drop_delegate<C>(pot: &mut Pot<C>, member: address) {
    if (df::exists(&pot.id, DelegateKey { member })) {
        let old: Delegate = df::remove(&mut pot.id, DelegateKey { member });
        event::emit(DelegateRevoked { pot: object::id(pot), member, agent: old.agent });
    };
}

fun assert_version<C>(pot: &Pot<C>) {
    assert!(pot.version == VERSION, EWrongVersion);
}

fun assert_open<C>(pot: &Pot<C>) {
    pot.assert_version();
    assert!(!pot.closed, EClosed);
}

fun assert_active<C>(pot: &Pot<C>, member: address) {
    assert!(pot.is_active(member), ENotMember);
}

fun assert_allowance<C>(pot: &Pot<C>, member: address, allowance: &Allowance<Balance<C>>) {
    pot.assert_active(member);
    let settings = allowance.settings();
    assert!(settings.funder() == member, EWrongAllowance);
    assert!(settings.name() == &pot.members.get(&member).allowance_name, EWrongAllowance);
    assert!(settings.spender() == option::some(pot.keeper), EWrongSpender);
}

// === Test-only ===

#[test_only]
public fun set_version_for_testing<C>(pot: &mut Pot<C>, version: u64) {
    pot.version = version;
}
