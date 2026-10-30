import Link from 'next/link';
import type { ReactNode } from 'react';

/** Comes from the API's /site endpoint, which reads the operator settings on the server. */
export type Operator = {
  name: string;
  email: string;
  address: string;
  governingLaw: string;
};

export type LegalSection = { id: string; title: string; body: ReactNode };

export type LegalDocument = {
  title: string;
  updated: string;
  intro: ReactNode;
  sections: LegalSection[];
};

/** Both documents change together, so they share one date. */
export const LEGAL_UPDATED = 'October 30, 2026';

export function Mail({ operator }: { operator?: Operator }) {
  return operator?.email ? (
    <a href={`mailto:${operator.email}`}>{operator.email}</a>
  ) : (
    <>our support address at the bottom of this page</>
  );
}

export function operatorName(operator?: Operator) {
  return operator?.name || 'the company that operates PriceCharm';
}

export function SectionLink({ id, children }: { id: string; children: ReactNode }) {
  return <a href={`#${id}`}>{children}</a>;
}

export function DocumentLink({ to, children }: { to: 'privacy' | 'terms'; children: ReactNode }) {
  return <Link href={`/${to}`}>{children}</Link>;
}

/**
 * On phones the rows stack, so each cell carries its column name for the label. The roles keep
 * the table readable as a table after CSS changes its display.
 */
export function LegalTable({ head, rows }: { head: string[]; rows: ReactNode[][] }) {
  return (
    <div className="legal-table">
      <table role="table">
        <thead role="rowgroup">
          <tr role="row">
            {head.map((label) => (
              <th key={label} scope="col" role="columnheader">
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody role="rowgroup">
          {rows.map((cells, row) => (
            <tr key={row} role="row">
              {cells.map((cell, column) => (
                <td key={column} role="cell" data-label={head[column]}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
