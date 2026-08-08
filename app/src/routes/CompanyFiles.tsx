import FilesPanel from '../components/FilesPanel'
import { useRecord } from './CompanyRecord'

/* The Files tab — the company's filing cabinet. Nothing here affects the header. */
export default function CompanyFiles() {
  const { company } = useRecord()
  return <FilesPanel companyId={company.id} />
}
