/*
 * The top-level sections of the ERP.
 *
 * Most of these are not built yet. Rather than hide them until they are, each gets
 * an honest placeholder that says what it is for and what it will draw on — so the
 * shape of the system is visible, and nobody has to guess whether a blank section
 * means "empty" or "not written".
 *
 * `live` links point at the parts that DO work today, so a placeholder is never a
 * dead end. Delete a section's entry here and both its nav item and its route go
 * with it — this list is the single source for both.
 */

export interface Section {
  key: string
  path: string
  label: string
  /** One line: what this section is for. */
  purpose: string
  /** What will live here, once it does. */
  planned: string[]
  /** What already exists that this section will build on. Omit if nothing does. */
  foundation?: string
  /** Working pages worth pointing at from here. */
  live?: { to: string; label: string; note: string }[]
  /** Built for real — keeps its nav item but gets no placeholder route. */
  built?: boolean
}

export const SECTIONS: Section[] = [
  {
    key: 'home',
    path: '/',
    label: 'Home',
    purpose: 'Where the day starts — what is assigned to you, what is blocked, what is due.',
    planned: [
      'Your open tickets across every client, newest first',
      'Anything roadblocked, with who flagged it and when',
      'Hours logged this week against the sprint',
      'Clients with no activity in the last fortnight',
    ],
    foundation:
      'Tickets already carry an assignee, a roadblock flag with its reason, a sprint and a time log, ' +
      'so this is a matter of arranging what is already recorded.',
    live: [
      { to: '/clients', label: 'Clients', note: 'the company list, live — open one to reach its tickets' },
    ],
  },
  {
    key: 'clients',
    path: '/clients',
    label: 'Clients',
    built: true,
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
    key: 'sprints',
    path: '/sprints',
    label: 'Sprints',
    built: true,
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
    purpose: 'The sales side: who we are talking to, what stage they are at, and what happens next.',
    planned: [
      'A call and note timeline against each company',
      'Contacts as their own records, not one primary per company',
      'Conference ROI, once there are conferences to attribute to',
      'Trends over time — the analysis that needs history to say anything',
    ],
    foundation:
      'Dashboard, Pipeline and Prospecting are live, on the same phases and lead sources beh uses.',
    live: [
      { to: '/crm/pipeline', label: 'Pipeline', note: 'open deals by phase, with the weighted forecast' },
      { to: '/crm/prospecting', label: 'Prospecting', note: 'leads with no open deal yet' },
    ],
  },
  {
    key: 'resources',
    path: '/resources',
    label: 'Resources',
    purpose: 'The shared shelf — the documents everyone keeps re-finding or re-writing.',
    planned: [
      'Implementation runbooks and go-live checklists',
      'Reusable form and report templates',
      'Onboarding material for new staff',
      'Links out to the platform docs that matter',
    ],
  },
  {
    key: 'reports',
    path: '/reports',
    label: 'Reports',
    purpose: 'The numbers the company runs on, pulled from the records rather than a spreadsheet.',
    planned: [
      'Hours by client, by person, by week — billable and not',
      'Throughput: tickets opened against closed',
      'Pipeline by stage and value',
      'Time-to-close, and where tickets actually sit and wait',
    ],
    foundation:
      'Logged hours are stored as a real number on every ticket, not only inside the time log, ' +
      'so BlueStep reports can total them without any of this being built first.',
  },
  {
    key: 'settings',
    path: '/settings',
    label: 'Settings',
    built: true,
    purpose: 'How Cobalt is set up: who works here, and the lists everything else picks from.',
    planned: [
      'Option lists — departments, deal phases, ticket statuses — editable rather than in code',
      'Permissions: who can move a company between stages, who can see money',
      'Default file folders per company type',
      'Integrations and API credentials',
    ],
    foundation:
      'Users is live: everyone in the system with their employment details and reporting line.',
  },
]
