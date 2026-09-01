/*
 * The top-level sections of the ERP.
 *
 * Most of these are not built yet. Rather than hide them until they are, each gets
 * an honest placeholder that says what it is for and what it will draw on, so the
 * shape of the system is visible, and nobody has to guess whether a blank section
 * means "empty" or "not written".
 *
 * `live` links point at the parts that DO work today, so a placeholder is never a
 * dead end. Delete a section's entry here and both its nav item and its route go
 * with it. This list is the single source for both.
 */

import type { Capability } from './api'

export interface Section {
  key: string
  path: string
  label: string
  /**
   * The capability required to see this section at all.
   *
   * Declared here rather than checked in the router, so a section's nav item and its
   * route can never disagree about who may reach it: the same reason this list drives
   * both in the first place. Omit for the sections everyone signed in can see.
   */
  needs?: Capability
  /** One line: what this section is for. */
  purpose: string
  /** What will live here, once it does. */
  planned: string[]
  /** What already exists that this section will build on. Omit if nothing does. */
  foundation?: string
  /** Working pages worth pointing at from here. */
  live?: { to: string; label: string; note: string }[]
  /** Built for real: keeps its nav item but gets no placeholder route. */
  built?: boolean
}

export const SECTIONS: Section[] = [
  {
    key: 'home',
    path: '/',
    label: 'Home',
    purpose: 'Where the day starts, what is assigned to you, what is blocked, what is due.',
    planned: [
      'Your open tickets across every client, newest first',
      'Anything roadblocked, with who flagged it and when',
      'Hours logged this week against the sprint',
      'Clients with no activity in the last fortnight',
    ],
    foundation:
      'Tickets already carry an accountable owner and a responsible engineer, a roadblock flag ' +
      'with its reason, a sprint, a time log and the components they changed, so this is a matter ' +
      'of arranging what is already recorded.',
    live: [
      { to: '/clients', label: 'Clients', note: 'the company list, live. Open one to reach its tickets' },
    ],
    built: true,
  },
  {
    key: 'clients',
    path: '/clients',
    label: 'Clients',
    built: true,
    needs: 'viewClients',
    purpose: 'Every company we work with, and everything hanging off its record.',
    planned: [
      'A single view of a client across tickets, hours and files',
      'Contract and renewal dates, so nothing lapses unnoticed',
      'Health at a glance: last activity, open roadblocks, unpaid time',
    ],
    foundation:
      'The list is live, and each record carries its info, contacts, files, account owner and tickets.',
  },
  {
    key: 'tickets',
    path: '/tickets',
    label: 'Tickets',
    built: true,
    needs: 'viewTickets',
    purpose: 'Every board in one place, scoped by list - including the lists that are ours.',
    planned: [
      'Cross-list filters that persist: mine, overdue, roadblocked',
      'Saved views, once there are enough lists to want one',
    ],
    foundation:
      'The same board a company record uses, over a list selector. A client board is also ' +
      'reachable through its record; this is the only route to a non-client list, which is ' +
      'what Product, Internal Dev and Platform Dev lists are.',
    live: [
      { to: '/tickets', label: 'All lists', note: 'every ticket, with its list named' },
    ],
  },
  {
    key: 'sprints',
    path: '/sprints',
    label: 'Sprints',
    built: true,
    needs: 'viewSprints',
    purpose: 'The weekly cycle: what was committed to, what shipped, and what rolled over.',
    planned: [
      'Rollover, so an unfinished ticket is carried rather than lost',
      'Per-sprint capacity overrides, for the weeks with holidays in them',
      'A retrospective panel: committed versus completed, per person',
      'Velocity over time, once there are enough weeks to average',
    ],
    foundation:
      'The board is live: a column per engineer measuring committed estimates against capacity, ' +
      'with the unsprinted backlog underneath.',
  },
  {
    key: 'crm',
    path: '/crm',
    label: 'CRM',
    built: true,
    needs: 'viewDeals',
    purpose: 'The sales side: who we are talking to, what stage they are at, and what happens next.',
    planned: [
      'A call and note timeline against each company',
      'Contacts as their own records, not one primary per company',
      'Conference ROI, once there are conferences to attribute to',
      'Trends over time: the analysis that needs history to say anything',
    ],
    foundation:
      'Dashboard, Pipeline and Prospecting are live, on the same phases and lead sources beh uses.',
    live: [
      { to: '/crm/pipeline', label: 'Pipeline', note: 'open deals by phase, with the weighted forecast' },
      { to: '/crm/prospecting', label: 'Prospecting', note: 'leads with no open deal yet' },
    ],
  },
  {
    key: 'cs',
    path: '/cs',
    label: 'Client Success',
    built: true,
    needs: 'viewCs',
    purpose: 'No client goes quiet, no bad signal goes unowned.',
    planned: [
      'Owner-scoped nudges when an account crosses into Red, once there is anything to send them with',
      'Per-contact survey targeting, when an account needs more than one voice heard',
      'NPS over time, once there is a year of identified answers worth charting',
      'A client-facing support panel: the strongest thing beh had that Cobalt does not',
    ],
    foundation:
      'Health is computed on every read from the touchpoint log, the survey responses and the ' +
      'calendar, so silence degrades an account with nobody typing anything, and a Red signal ' +
      'writes an owned, dated follow-up into the same queue the CRM already reads.',
    live: [
      { to: '/cs', label: 'Queue', note: 'every client, worst first, with the reason' },
      { to: '/cs/quarter', label: 'Quarter review', note: 'the printable one-pager' },
    ],
  },
  {
    key: 'resources',
    path: '/resources',
    label: 'Resources',
    built: true,
    purpose:
      'The engineering library: what we already solved, packaged so nobody solves it twice. ' +
      'An artifact is a versioned bundle of scripts, explainers and component source with an ' +
      'owner, an explainer on every change, and owner-approved merges.',
    planned: [
      'Company material beyond engineering (handbook, org chart, links) — the model carries a kind for it',
    ],
    live: [
      { to: '/resources', label: 'Artifacts', note: 'browse, search, pull' },
    ],
  },
  {
    key: 'reports',
    path: '/reports',
    label: 'Reports',
    built: true,
    needs: 'viewReports',
    purpose: 'The numbers the company runs on, pulled from the records rather than a spreadsheet.',
    planned: [
      'Hours by client, by person, by week: billable and not',
      'Throughput: tickets opened against closed',
      'Pipeline by stage and value',
      'Time-to-close, and where tickets actually sit and wait',
    ],
    foundation:
      'Logged hours are stored as a real number on every ticket, not only inside the time log, ' +
      'so BlueStep reports can total them without any of this being built first.',
    live: [
      { to: '/reports/time', label: 'Time Logging', note: 'where the hours go, by week, person, client and hour of day' },
    ],
  },
  {
    key: 'settings',
    path: '/settings',
    label: 'Settings',
    built: true,
    needs: 'viewSettings',
    purpose: 'How Cobalt is set up: who works here, and the lists everything else picks from.',
    planned: [
      'Option lists, departments, deal phases, ticket statuses: editable rather than in code',
      'Permissions: who can move a company between stages, who can see money',
      'Default file folders per company type',
      'Integrations and API credentials',
    ],
    foundation:
      'Users is live: everyone in the system with their employment details and reporting line.',
  },
]
