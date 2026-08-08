import ContactsPanel from '../components/ContactsPanel'
import { useRecord } from './CompanyRecord'

/* The Contacts tab. The panel owns the people; this only says which company they are at,
   and re-reads the record when the primary changes, because the header shows it. */
export default function CompanyContacts() {
  const { company, reload } = useRecord()
  return <ContactsPanel companyId={company.id} onMirror={reload} />
}
