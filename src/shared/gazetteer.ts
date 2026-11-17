/**
 * Well-known places and software, so a name like "Denver" or "Jira" is given the right kind with no
 * model and no cue words around it. Matched with the exact capitalisation written here.
 */
const PLACES = `
Afghanistan Albania Algeria Argentina Armenia Australia Austria Azerbaijan Bahamas Bahrain Bangladesh Belarus Belgium Bolivia Bosnia Brazil Bulgaria Cambodia Cameroon Canada Chile China Colombia Croatia Cuba Cyprus Czechia Denmark Ecuador Egypt Estonia Ethiopia Finland France Georgia Germany Ghana Greece Guatemala Haiti Honduras Hungary Iceland India Indonesia Iran Iraq Ireland Israel Italy Jamaica Japan Jordan Kazakhstan Kenya Kuwait Latvia Lebanon Libya Lithuania Luxembourg Malaysia Malta Mexico Moldova Mongolia Morocco Nepal Netherlands Nicaragua Nigeria Norway Oman Pakistan Panama Paraguay Peru Philippines Poland Portugal Qatar Romania Russia Rwanda Senegal Serbia Singapore Slovakia Slovenia Somalia Spain Sudan Sweden Switzerland Syria Taiwan Tanzania Thailand Tunisia Turkey Uganda Ukraine Uruguay Uzbekistan Venezuela Vietnam Yemen Zambia Zimbabwe
Europe Asia Africa Antarctica Scandinavia Benelux EMEA APAC LATAM
Alabama Alaska Arizona Arkansas California Colorado Connecticut Delaware Florida Hawaii Idaho Illinois Indiana Iowa Kansas Kentucky Louisiana Maine Maryland Massachusetts Michigan Minnesota Mississippi Missouri Montana Nebraska Nevada Ohio Oklahoma Oregon Pennsylvania Tennessee Texas Utah Vermont Virginia Washington Wisconsin Wyoming
Ontario Quebec Alberta Manitoba Saskatchewan Scotland Wales England Bavaria Catalonia Queensland Victoria Tasmania
Atlanta Austin Baltimore Boston Charlotte Chicago Cincinnati Cleveland Dallas Denver Detroit Houston Indianapolis Jacksonville Miami Milwaukee Minneapolis Nashville Oakland Orlando Philadelphia Phoenix Pittsburgh Portland Raleigh Sacramento Seattle Tampa Tucson Tulsa Honolulu Anchorage Boise Omaha Albuquerque Memphis Richmond Norfolk Louisville
Toronto Vancouver Montreal Ottawa Calgary Edmonton Winnipeg Halifax
London Manchester Birmingham Liverpool Leeds Glasgow Edinburgh Bristol Cardiff Belfast Dublin Cork Paris Lyon Marseille Berlin Munich Hamburg Frankfurt Cologne Stuttgart Dusseldorf Madrid Barcelona Valencia Seville Lisbon Porto Rome Milan Naples Turin Florence Venice Amsterdam Rotterdam Brussels Antwerp Zurich Geneva Basel Vienna Prague Warsaw Krakow Budapest Bucharest Sofia Athens Istanbul Stockholm Gothenburg Oslo Copenhagen Helsinki Tallinn Riga Vilnius Kyiv Moscow
Tokyo Osaka Kyoto Seoul Busan Beijing Shanghai Shenzhen Guangzhou Hangzhou Chengdu Taipei Hanoi Saigon Bangkok Jakarta Manila Mumbai Delhi Bangalore Bengaluru Hyderabad Chennai Pune Kolkata Karachi Lahore Dhaka Colombo Kathmandu Dubai Doha Riyadh Jeddah Muscat Tehran Baghdad Amman Beirut Cairo Casablanca Lagos Nairobi Accra Johannesburg Durban
Sydney Melbourne Brisbane Perth Adelaide Canberra Auckland Wellington Christchurch
Rio Santiago Lima Bogota Quito Caracas Havana Cancun Guadalajara Monterrey
New York,Panama City,San Francisco,Los Angeles,San Diego,San Jose,Las Vegas,Salt Lake City,Kansas City,New Orleans,St. Louis,Washington DC,Hong Kong,Tel Aviv,Abu Dhabi,Mexico City,Rio de Janeiro,Buenos Aires,Cape Town,Sao Paulo,New Delhi,Kuala Lumpur,Palo Alto,Mountain View,Silicon Valley,Fort Worth,San Antonio,Virginia Beach,Colorado Springs,Oklahoma City,Santa Clara,Santa Monica,Redwood City,Menlo Park,Cambridge,Oxford
`

const SOFTWARE = `
Jira Confluence Bitbucket Trello Asana Monday Notion Slack Teams Zoom Webex Skype Discord Salesforce HubSpot Zendesk Freshdesk ServiceNow Workday SAP Oracle NetSuite Concur Coupa Ariba Tableau Looker PowerBI Snowflake Databricks Redshift BigQuery Splunk Datadog NewRelic Dynatrace PagerDuty Grafana Prometheus Kibana Elasticsearch Kafka Redis MongoDB Postgres PostgreSQL MySQL MariaDB SQLite Cassandra DynamoDB Terraform Ansible Puppet Chef Jenkins CircleCI GitHub GitLab Docker Kubernetes OpenShift Helm Istio Vault Consul Nomad AWS Azure GCP Cloudflare Akamai Fastly Okta Auth0 Ping CrowdStrike SentinelOne Fortinet FortiGate Meraki Cisco Juniper Arista VMware ESXi vSphere Citrix Nutanix Veeam Commvault Rubrik Cohesity NetApp Dell HP Lenovo Intune Jamf SCCM Exchange SharePoint OneDrive OneNote Outlook Excel PowerPoint Word Office Gmail Drive Docs Sheets Slides Dropbox Box Figma Sketch Canva Miro Lucidchart Visio Photoshop Illustrator Postman Swagger Sentry Rollbar LaunchDarkly Optimizely Segment Mixpanel Amplitude Heap Hotjar Intercom Drift Gong Outreach Marketo Eloqua Pardot Mailchimp Twilio SendGrid Stripe PayPal Square Adyen Plaid Shopify Magento WordPress Drupal Contentful Sitecore Adobe Linux Ubuntu Debian CentOS RHEL Windows macOS Android iOS Chrome Firefox Safari Edge Python Java JavaScript TypeScript Node Rust Golang Kotlin Swift React Angular Vue Django Flask Spring Rails Laravel Jupyter Anaconda Airflow dbt Fivetran Informatica Talend Alteryx Qlik Domo Sisense
`

const split = (s: string, sep: RegExp): string[] =>
  s
    .split(sep)
    .map((x) => x.trim())
    .filter(Boolean)

/** Multi-word entries are comma separated in the lists above; the rest are single words. */
function parse(list: string): string[] {
  const out: string[] = []
  for (const line of list.split('\n')) {
    if (line.includes(',')) out.push(...split(line, /,/))
    else out.push(...split(line, /\s+/))
  }
  return out
}

// A few place names double as everyday words or names; they are left to the other rules.
const NOT_PLACES = new Set([
  'Georgia',
  'Virginia',
  'Victoria',
  'Washington',
  'Cambridge',
  'Oxford',
  'Phoenix',
  'Austin',
  'Charlotte',
  'Florence',
  'Jordan',
  'Lima',
  'Santiago',
  'Richmond',
  'Portland',
  'Nashville',
  'Memphis',
  'Rio',
  'Cork',
  'Perth'
])
// Software that is also an ordinary capitalised word.
const NOT_SOFTWARE = new Set([
  'Monday',
  'Teams',
  'Word',
  'Office',
  'Drive',
  'Docs',
  'Sheets',
  'Slides',
  'Box',
  'Edge',
  'Square',
  'Pure',
  'Ping',
  'Swift',
  'Node',
  'Chef',
  'Vault',
  'Consul',
  'Nomad',
  'Segment',
  'Heap',
  'Notion',
  'Exchange',
  'Dell',
  'Outreach',
  'Palo',
  'Alto',
  'Chrome',
  'Safari',
  'Spring',
  'Rails',
  'Drift',
  'Gong',
  'Helm',
  'Looker'
])

const placeList = parse(PLACES).filter((p) => !NOT_PLACES.has(p))
const softwareList = parse(SOFTWARE).filter((p) => !NOT_SOFTWARE.has(p))

/** Names that are unmistakably one kind, with the exact capitalisation to look for. */
export const GAZETTEER: ReadonlyMap<string, 'place' | 'system'> = new Map([
  ...placeList.map((p) => [p, 'place'] as const),
  ...softwareList.map((p) => [p, 'system'] as const)
])

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** One pattern over every entry, longest first ("New York" before "New"). */
export const GAZETTEER_RE = new RegExp(
  `(?<![\\p{L}\\p{N}@#])(?:${[...GAZETTEER.keys()]
    .sort((a, b) => b.length - a.length)
    .map(esc)
    .join('|')})(?![\\p{L}\\p{N}])`,
  'gu'
)
