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
    key: 'crm',
    path: '/crm',
    label: 'CRM',
    purpose: 'The sales side: who we are talking to, what stage they are at, and what happens next.',
    planned: [
      'Deals with a value and a close date',
      'Contacts against each company, not just the company',
      'Notes and call logs on a timeline',
      'Follow-ups that appear on Home when they come due',
    ],
    foundation:
      'The Company record and its Lead / Client / Former Client stages are the spine of this, and both exist. ' +
      'Moving a company between stages still needs the Category Editor permission granted.',
    live: [
      { to: '/clients', label: 'Clients', note: 'companies in the Client stage' },
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
    key: 'sprints',
    path: '/sprints',
    label: 'Sprints',
    purpose: 'The weekly cycle: what was committed to, what shipped, and what rolled over.',
    planned: [
      'A sprint board across every list, not one client at a time',
      'Committed versus completed, per person',
      'Estimated against logged hours for the week',
      'Rollover, so an unfinished ticket is carried rather than lost',
    ],
    foundation:
      'Every ticket already has a sprint field and a time log. beh has a Sprint Maestro and Sprint Organizer ' +
      'to port from rather than design fresh.',
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
]
