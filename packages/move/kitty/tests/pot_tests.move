#[test_only]
module kitty::pot_tests;

use kitty::pot::{Self, KITTY, Pot, Contributed, Spent, Refunded};
use sui::allowance::{Self, Allowance, AllowanceCap};
use sui::balance::{Self, Balance};
use sui::clock::{Self, Clock};
use sui::event;
use sui::test_scenario::{Self as ts, Scenario};

public struct TEST has store {}

const A: address = @0xA;
const B: address = @0xB;
const C: address = @0xC;
const KEEPER: address = @0xEE;
const PAYEE: address = @0xF0;
const STRANGER: address = @0x99;

const FUNDS: u64 = 10_000;
const PER_HOUR: u256 = 500;
const DEADLINE: u64 = 1_000_000;
const AUTO_CAP: u64 = 100;

// === Harness ===

/// A pot (quorum 2, auto-ok 100) with A, B and C joined, each capped at 500 per hour.
fun setup(): (Scenario, Clock, vector<ID>) {
    let mut scenario = ts::begin(A);
    let clock = clock::create_for_testing(scenario.ctx());
    balance::create_for_testing<TEST>(FUNDS).send_funds(A);
    balance::create_for_testing<TEST>(FUNDS).send_funds(B);
    balance::create_for_testing<TEST>(FUNDS).send_funds(C);
    pot::create<TEST>(b"Da Lat trip".to_string(), 3_000, DEADLINE, KEEPER, 2, AUTO_CAP, scenario.ctx());
    let mut allowances = vector[];
    allowances.push_back(join(&mut scenario, A, KEEPER));
    allowances.push_back(join(&mut scenario, B, KEEPER));
    allowances.push_back(join(&mut scenario, C, KEEPER));
    (scenario, clock, allowances)
}

fun join(scenario: &mut Scenario, member: address, spender: address): ID {
    scenario.next_tx(member);
    let mut pot = scenario.take_shared<Pot<TEST>>();
    let proposal = allowance::propose_for_app<Balance<TEST>, KITTY>(
        b"kitty:da-lat".to_string(),
        spender,
        option::none(),
        option::none(),
        option::some(DEADLINE),
        option::some(allowance::periodic_rate_limit(3_600_000, PER_HOUR)),
        scenario.ctx(),
    );
    pot::join(&mut pot, proposal, scenario.ctx());
    ts::return_shared(pot);
    scenario.next_tx(member);
    ts::most_recent_id_shared<Allowance<Balance<TEST>>>().destroy_some()
}

/// `sender` pulls `amount` from the member behind `allowance_id`.
fun pull_as(
    scenario: &mut Scenario,
    clock: &Clock,
    sender: address,
    allowance_id: ID,
    funder: address,
    amount: u64,
) {
    scenario.next_tx(sender);
    let mut pot = scenario.take_shared<Pot<TEST>>();
    let mut alw = scenario.take_shared_by_id<Allowance<Balance<TEST>>>(allowance_id);
    let w = allowance::new_withdrawal_for_testing<Balance<TEST>>(
        allowance_id,
        ts::withdraw_balance_from_address<TEST>(funder, amount),
    );
    pot::contribute(&mut pot, &mut alw, w, clock, scenario.ctx());
    ts::return_shared(alw);
    ts::return_shared(pot);
}

fun pull(scenario: &mut Scenario, clock: &Clock, allowance_id: ID, funder: address, amount: u64) {
    pull_as(scenario, clock, KEEPER, allowance_id, funder, amount);
}

macro fun with_pot($scenario: &mut Scenario, $sender: address, $f: |&mut Pot<TEST>, &mut TxContext|) {
    let scenario = $scenario;
    scenario.next_tx($sender);
    let mut pot = scenario.take_shared<Pot<TEST>>();
    $f(&mut pot, scenario.ctx());
    ts::return_shared(pot);
}

fun settled(scenario: &mut Scenario, who: address): u64 {
    scenario.next_tx(STRANGER);
    ts::settled_balance<TEST>(who)
}

fun finish(scenario: Scenario, clock: Clock) {
    clock.destroy_for_testing();
    scenario.end();
}

/// A puts in 300, B 200, C 100.
fun funded(): (Scenario, Clock, vector<ID>) {
    let (mut scenario, clock, alws) = setup();
    pull(&mut scenario, &clock, alws[0], A, 300);
    pull(&mut scenario, &clock, alws[1], B, 200);
    pull(&mut scenario, &clock, alws[2], C, 100);
    (scenario, clock, alws)
}

// === Paths ===

#[test]
fun a_pull_moves_a_share_into_the_pot() {
    let (mut scenario, clock, alws) = setup();
    pull(&mut scenario, &clock, alws[0], A, 300);
    let events = event::events_by_type<Contributed>();
    assert!(events.length() == 1);
    with_pot!(&mut scenario, A, |p, _ctx| {
        assert!(p.balance_value() == 300);
        assert!(p.contributed(A) == 300);
        assert!(p.total_in() == 300);
    });
    assert!(settled(&mut scenario, A) == FUNDS - 300);
    finish(scenario, clock);
}

#[test]
fun a_spend_executes_at_quorum_and_pays_the_payee() {
    let (mut scenario, clock, _alws) = funded();
    with_pot!(&mut scenario, B, |p, ctx| {
        let id = p.propose_spend(PAYEE, 250, b"hotel".to_string(), ctx);
        assert!(id == 0);
    });
    with_pot!(&mut scenario, C, |p, ctx| p.approve(0, ctx));
    with_pot!(&mut scenario, C, |p, ctx| p.execute(0, ctx));
    assert!(event::events_by_type<Spent>().length() == 1);
    assert!(settled(&mut scenario, PAYEE) == 250);
    with_pot!(&mut scenario, A, |p, _ctx| {
        assert!(p.balance_value() == 350);
        assert!(p.total_out() == 250);
    });
    finish(scenario, clock);
}

#[test]
fun the_group_votes_an_auto_ok_cap_and_spends_inside_it() {
    let (mut scenario, clock, _alws) = funded();
    with_pot!(&mut scenario, A, |p, ctx| p.spend_auto(PAYEE, 100, b"food".to_string(), ctx));
    with_pot!(&mut scenario, A, |p, ctx| {
        p.propose_auto_ok_cap(150, ctx);
    });
    with_pot!(&mut scenario, B, |p, ctx| p.approve(0, ctx));
    with_pot!(&mut scenario, B, |p, ctx| p.execute(0, ctx));
    with_pot!(&mut scenario, C, |p, ctx| {
        assert!(p.auto_ok_cap() == 150);
        p.spend_auto(PAYEE, 140, b"dinner".to_string(), ctx);
    });
    assert!(settled(&mut scenario, PAYEE) == 240);
    finish(scenario, clock);
}

#[test]
fun close_by_vote_refunds_pro_rata() {
    let (mut scenario, clock, _alws) = funded();
    with_pot!(&mut scenario, A, |p, ctx| p.spend_auto(PAYEE, 60, b"snacks".to_string(), ctx));
    with_pot!(&mut scenario, A, |p, ctx| {
        p.propose_close(ctx);
    });
    with_pot!(&mut scenario, B, |p, ctx| p.approve(0, ctx));
    with_pot!(&mut scenario, A, |p, ctx| p.execute(0, ctx));
    assert!(event::events_by_type<Refunded>().length() == 3);
    // 540 left of 600 put in: 270 / 180 / 90.
    assert!(settled(&mut scenario, A) == FUNDS - 300 + 270);
    assert!(settled(&mut scenario, B) == FUNDS - 200 + 180);
    assert!(settled(&mut scenario, C) == FUNDS - 100 + 90);
    with_pot!(&mut scenario, A, |p, _ctx| {
        assert!(p.is_closed());
        assert!(p.balance_value() == 0);
    });
    finish(scenario, clock);
}

#[test]
fun rounding_dust_goes_to_the_last_contributor() {
    let (mut scenario, clock, alws) = setup();
    pull(&mut scenario, &clock, alws[0], A, 1);
    pull(&mut scenario, &clock, alws[1], B, 1);
    pull(&mut scenario, &clock, alws[2], C, 1);
    with_pot!(&mut scenario, A, |p, ctx| p.spend_auto(PAYEE, 1, b"x".to_string(), ctx));
    let mut clock = clock;
    clock.set_for_testing(DEADLINE);
    scenario.next_tx(STRANGER);
    let mut p = scenario.take_shared<Pot<TEST>>();
    p.close_after_deadline(&clock);
    assert!(p.balance_value() == 0);
    ts::return_shared(p);
    let total = settled(&mut scenario, A) + settled(&mut scenario, B) + settled(&mut scenario, C);
    assert!(total == 3 * FUNDS - 3 + 2);
    finish(scenario, clock);
}

#[test]
fun a_member_who_leaves_stops_pulls_but_keeps_their_share() {
    let (mut scenario, clock, alws) = funded();
    scenario.next_tx(A);
    let mut p = scenario.take_shared<Pot<TEST>>();
    let cap = scenario.take_from_sender<AllowanceCap<Balance<TEST>>>();
    let alw = scenario.take_shared_by_id<Allowance<Balance<TEST>>>(alws[0]);
    p.leave(cap, alw, scenario.ctx());
    assert!(!p.is_active(A));
    assert!(p.contributed(A) == 300);
    ts::return_shared(p);
    finish(scenario, clock);
}

// === Aborts ===

#[test, expected_failure(abort_code = sui::allowance::EExceedsRateLimit)]
fun a_pull_over_the_window_cap_aborts() {
    let (mut scenario, clock, alws) = setup();
    pull(&mut scenario, &clock, alws[0], A, 501);
    finish(scenario, clock);
}

#[test, expected_failure(abort_code = pot::ENotKeeper)]
fun only_the_keeper_pulls() {
    let (mut scenario, clock, alws) = setup();
    pull_as(&mut scenario, &clock, B, alws[0], A, 10);
    finish(scenario, clock);
}

#[test, expected_failure(abort_code = pot::EWrongSpender)]
fun joining_with_another_spender_aborts() {
    let mut scenario = ts::begin(A);
    pot::create<TEST>(b"x".to_string(), 1, DEADLINE, KEEPER, 1, 0, scenario.ctx());
    join(&mut scenario, A, STRANGER);
    scenario.end();
}

#[test, expected_failure(abort_code = pot::EAlreadyMember)]
fun joining_twice_aborts() {
    let (mut scenario, clock, _alws) = setup();
    join(&mut scenario, A, KEEPER);
    finish(scenario, clock);
}

#[test, expected_failure(abort_code = pot::EUnderQuorum)]
fun a_spend_below_quorum_aborts() {
    let (mut scenario, clock, _alws) = funded();
    with_pot!(&mut scenario, B, |p, ctx| {
        p.propose_spend(PAYEE, 250, b"hotel".to_string(), ctx);
    });
    with_pot!(&mut scenario, B, |p, ctx| p.execute(0, ctx));
    finish(scenario, clock);
}

#[test, expected_failure(abort_code = pot::EOverAutoCap)]
fun an_auto_spend_above_the_cap_aborts() {
    let (mut scenario, clock, _alws) = funded();
    with_pot!(&mut scenario, A, |p, ctx| p.spend_auto(PAYEE, AUTO_CAP + 1, b"dinner".to_string(), ctx));
    finish(scenario, clock);
}

#[test, expected_failure(abort_code = pot::EOverBalance)]
fun a_spend_beyond_the_balance_aborts() {
    let (mut scenario, clock, _alws) = funded();
    with_pot!(&mut scenario, B, |p, ctx| {
        p.propose_spend(PAYEE, 601, b"too much".to_string(), ctx);
    });
    with_pot!(&mut scenario, C, |p, ctx| p.approve(0, ctx));
    with_pot!(&mut scenario, C, |p, ctx| p.execute(0, ctx));
    finish(scenario, clock);
}

#[test, expected_failure(abort_code = pot::EAlreadyApproved)]
fun approving_twice_aborts() {
    let (mut scenario, clock, _alws) = funded();
    with_pot!(&mut scenario, B, |p, ctx| {
        p.propose_spend(PAYEE, 10, b"x".to_string(), ctx);
    });
    with_pot!(&mut scenario, B, |p, ctx| p.approve(0, ctx));
    finish(scenario, clock);
}

#[test, expected_failure(abort_code = pot::EExecuted)]
fun executing_twice_aborts() {
    let (mut scenario, clock, _alws) = funded();
    with_pot!(&mut scenario, B, |p, ctx| {
        p.propose_spend(PAYEE, 10, b"x".to_string(), ctx);
    });
    with_pot!(&mut scenario, C, |p, ctx| p.approve(0, ctx));
    with_pot!(&mut scenario, C, |p, ctx| p.execute(0, ctx));
    with_pot!(&mut scenario, C, |p, ctx| p.execute(0, ctx));
    finish(scenario, clock);
}

#[test, expected_failure(abort_code = pot::ENotMember)]
fun a_stranger_cannot_propose() {
    let (mut scenario, clock, _alws) = funded();
    with_pot!(&mut scenario, STRANGER, |p, ctx| {
        p.propose_spend(STRANGER, 10, b"mine".to_string(), ctx);
    });
    finish(scenario, clock);
}

#[test, expected_failure(abort_code = pot::ENotMember)]
fun a_member_who_left_cannot_approve() {
    let (mut scenario, clock, alws) = funded();
    scenario.next_tx(A);
    let mut p = scenario.take_shared<Pot<TEST>>();
    let cap = scenario.take_from_sender<AllowanceCap<Balance<TEST>>>();
    let alw = scenario.take_shared_by_id<Allowance<Balance<TEST>>>(alws[0]);
    p.leave(cap, alw, scenario.ctx());
    ts::return_shared(p);
    with_pot!(&mut scenario, B, |p, ctx| {
        p.propose_spend(PAYEE, 10, b"x".to_string(), ctx);
    });
    with_pot!(&mut scenario, A, |p, ctx| p.approve(0, ctx));
    finish(scenario, clock);
}

#[test, expected_failure(abort_code = pot::ETooEarly)]
fun closing_before_the_deadline_needs_a_vote() {
    let (mut scenario, clock, _alws) = funded();
    scenario.next_tx(STRANGER);
    let mut p = scenario.take_shared<Pot<TEST>>();
    p.close_after_deadline(&clock);
    ts::return_shared(p);
    finish(scenario, clock);
}

#[test, expected_failure(abort_code = pot::EClosed)]
fun a_closed_pot_takes_no_more_pulls() {
    let (mut scenario, clock, alws) = funded();
    with_pot!(&mut scenario, A, |p, ctx| {
        p.propose_close(ctx);
    });
    with_pot!(&mut scenario, B, |p, ctx| p.approve(0, ctx));
    with_pot!(&mut scenario, A, |p, ctx| p.execute(0, ctx));
    pull(&mut scenario, &clock, alws[1], B, 10);
    finish(scenario, clock);
}

#[test, expected_failure(abort_code = pot::EWrongVersion)]
fun an_old_pot_must_migrate_first() {
    let (mut scenario, clock, alws) = setup();
    with_pot!(&mut scenario, A, |p, _ctx| p.set_version_for_testing(0));
    pull(&mut scenario, &clock, alws[0], A, 10);
    finish(scenario, clock);
}

#[test]
fun migrate_moves_an_old_pot_forward() {
    let (mut scenario, clock, alws) = setup();
    with_pot!(&mut scenario, A, |p, _ctx| {
        p.set_version_for_testing(0);
        p.migrate();
        assert!(p.version() == 1);
    });
    pull(&mut scenario, &clock, alws[0], A, 10);
    finish(scenario, clock);
}
