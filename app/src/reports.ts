import type { Capability } from './api'

/*
 * The reports, as data.
 *
 * The Reports section is a DIRECTORY, not a dashboard: a place to find the report you
 * came for, with enough of a description that you know before clicking. Same reasoning
 * as `sections.ts` and the same single-source shape - this list drives both the cards
 * and (via `path`) the routes, so a report cannot be listed without being reachable or
 * reachable without being listed.
 *
 * Adding the next one is one entry here plus its route. Deliberately not derived from
 * the routes themselves: a report needs a sentence written by a person about what
 * question it answers, and that cannot be inferred from a path.
 */

export interface ReportCard {
  key: string
  path: string
  name: string
  /** One line: the question this report answers. Not a feature list. */
  description: string
  /** What it draws on, so a reader can judge how much to trust it. */
  source?: string
  /** Capability required to open it. Omit for everyone who can see the section. */
  needs?: Capability
}

export const REPORTS: ReportCard[] = [
  {
    key: 'time',
    path: '/reports/time',
    name: 'Time Logging',
    description:
      'Where the hours go: week over week, who logged them, which clients they landed ' +
      'on, what was billable, and what time of day the work actually happens.',
    source:
      'Every time entry on every ticket, from 2025 onward. Clock times come from the ' +
      'timer where one was used and from the ClickUp history everywhere else.',
    needs: 'viewReports',
  },
]
