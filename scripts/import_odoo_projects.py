#!/usr/bin/env python3
"""
Import CRM opportunities and projects from Odoo into openerp DB.
- Marks CRM contact partners as is_client=True
- Imports CRM leads as projects (type=crm_opportunity)
- Imports Odoo projects as projects (type=internal/poc)
"""
import re
import os
import psycopg2
import psycopg2.extras

ODOO_DSN = os.environ.get("ODOO_DSN", "host=localhost port=5432 dbname=odoo user=odoo password=")
OPENERP_DSN = "host=172.22.0.4 port=5432 dbname=openerp user=openerp password=EnoHammock3413!"

def strip_html(text):
    if not text:
        return None
    clean = re.sub(r'<[^>]+>', ' ', text)
    clean = re.sub(r'&nbsp;', ' ', clean)
    clean = re.sub(r'&amp;', '&', clean)
    clean = re.sub(r'\s+', ' ', clean).strip()
    return clean or None

def extract_lang(jsonb_name):
    """Extract en_US string from Odoo JSONB name field (comes as dict from psycopg2)."""
    if not jsonb_name:
        return None
    if isinstance(jsonb_name, dict):
        return jsonb_name.get('en_US') or next(iter(jsonb_name.values()), None)
    # fallback: regex on string representation
    m = re.search(r'["\']en_US["\']\s*:\s*["\']([^"\']*)["\']', str(jsonb_name))
    return m.group(1) if m else str(jsonb_name)

odoo = psycopg2.connect(ODOO_DSN)
openerp = psycopg2.connect(OPENERP_DSN)
odoo_cur = odoo.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
sym_cur = openerp.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
sym_write = openerp.cursor()

# ── Build openerp contact lookup ───────────────────────────────────────────────
sym_cur.execute("SELECT contact_id, name, email, odoo_id FROM contacts")
all_contacts = sym_cur.fetchall()
by_odoo_id = {r['odoo_id']: r['contact_id'] for r in all_contacts if r['odoo_id']}
by_email = {r['email'].lower(): r['contact_id'] for r in all_contacts if r['email']}
by_name = {r['name'].lower(): r['contact_id'] for r in all_contacts}

def find_contact(odoo_partner_id, partner_name=None, partner_email=None):
    if odoo_partner_id and odoo_partner_id in by_odoo_id:
        return by_odoo_id[odoo_partner_id]
    if partner_email and partner_email.lower() in by_email:
        return by_email[partner_email.lower()]
    if partner_name and partner_name.lower() in by_name:
        return by_name[partner_name.lower()]
    return None

def mark_client(contact_id):
    if contact_id:
        sym_write.execute(
            "UPDATE contacts SET is_client = TRUE, updated_at = NOW() WHERE contact_id = %s",
            (str(contact_id),)
        )

# ── 1. Import CRM leads ───────────────────────────────────────────────────────
print("=== Importing CRM opportunities ===")
odoo_cur.execute("""
    SELECT cl.id, cl.name, cl.partner_id,
           COALESCE(rp.name, cl.partner_name) as partner_name,
           rp.email as partner_email,
           cs.name as stage_name, cs.sequence as stage_seq,
           cl.probability, cl.expected_revenue,
           cl.date_deadline, cl.won_status, cl.active,
           cl.description
    FROM crm_lead cl
    LEFT JOIN crm_stage cs ON cs.id = cl.stage_id
    LEFT JOIN res_partner rp ON rp.id = cl.partner_id
    WHERE cl.active = TRUE
    ORDER BY cs.sequence, cl.name
""")
crm_leads = odoo_cur.fetchall()
print(f"  Found {len(crm_leads)} CRM opportunities")

for lead in crm_leads:
    stage = extract_lang(lead['stage_name']) or 'New'
    won_status = lead['won_status']

    if won_status == 'won':
        status = 'won'
    elif stage in ('Inactive', 'No Response'):
        status = 'inactive'
    else:
        status = 'active'

    contact_id = find_contact(lead['partner_id'], lead['partner_name'], lead['partner_email'])
    if contact_id:
        mark_client(contact_id)

    # Check if already imported
    sym_cur.execute("SELECT project_id FROM projects WHERE odoo_crm_id = %s", (lead['id'],))
    existing = sym_cur.fetchone()

    notes = strip_html(lead['description'])
    deadline = lead['date_deadline'].date() if lead['date_deadline'] else None

    if existing:
        sym_write.execute("""
            UPDATE projects SET
                name=%s, stage=%s, status=%s, contact_id=%s,
                probability=%s, expected_revenue=%s, date_deadline=%s,
                notes=%s, updated_at=NOW()
            WHERE odoo_crm_id=%s
        """, (
            lead['name'], stage, status,
            str(contact_id) if contact_id else None,
            lead['probability'], lead['expected_revenue'], deadline,
            notes, lead['id']
        ))
        print(f"  ~ Updated CRM: {lead['name']}")
    else:
        sym_write.execute("""
            INSERT INTO projects (
                name, project_type, stage, status, contact_id,
                odoo_crm_id, probability, expected_revenue,
                date_deadline, notes, tags
            ) VALUES (%s,'crm_opportunity',%s,%s,%s,%s,%s,%s,%s,%s,'{}')
        """, (
            lead['name'], stage, status,
            str(contact_id) if contact_id else None,
            lead['id'], lead['probability'], lead['expected_revenue'],
            deadline, notes
        ))
        print(f"  + CRM: {lead['name']} [{stage}] → contact: {lead['partner_name']}")

# ── 2. Import Odoo projects ────────────────────────────────────────────────────
print("\n=== Importing Odoo projects ===")

STATUS_MAP = {
    'to_define': 'active',
    'on_track': 'active',
    'at_risk': 'at_risk',
    'off_track': 'off_track',
    'on_hold': 'on_hold',
}

# Determine project type from name
def project_type_from_name(name):
    n = name.lower()
    if n.startswith('poc:'):
        return 'poc'
    if any(k in n for k in ['internal', 'ops:', 'admin', 'finance', 'laboratory']):
        return 'internal'
    if any(k in n for k in ['funding', 'grant', 'budget', 'tax']):
        return 'funding'
    return 'project'

odoo_cur.execute("""
    SELECT pp.id, pp.name, pp.partner_id, rp.name as partner_name,
           rp.email as partner_email,
           pp.date_start, pp.date as date_end,
           pp.last_update_status, pp.description
    FROM project_project pp
    LEFT JOIN res_partner rp ON rp.id = pp.partner_id
    WHERE pp.active = TRUE
    ORDER BY pp.name
""")
odoo_projects = odoo_cur.fetchall()
print(f"  Found {len(odoo_projects)} Odoo projects")

for proj in odoo_projects:
    pname = extract_lang(proj['name'])
    status = STATUS_MAP.get(proj['last_update_status'], 'active')
    ptype = project_type_from_name(pname)
    contact_id = find_contact(proj['partner_id'], proj['partner_name'], proj['partner_email'])
    notes = strip_html(proj['description'])

    sym_cur.execute("SELECT project_id FROM projects WHERE odoo_project_id = %s", (proj['id'],))
    existing = sym_cur.fetchone()

    date_start = proj['date_start'] if proj['date_start'] else None
    date_end = proj['date_end'] if proj['date_end'] else None

    if existing:
        sym_write.execute("""
            UPDATE projects SET
                name=%s, status=%s, project_type=%s, contact_id=%s,
                date_start=%s, date_deadline=%s, notes=%s, updated_at=NOW()
            WHERE odoo_project_id=%s
        """, (pname, status, ptype, str(contact_id) if contact_id else None,
              date_start, date_end, notes, proj['id']))
        print(f"  ~ Updated project: {pname}")
    else:
        sym_write.execute("""
            INSERT INTO projects (
                name, project_type, status, contact_id,
                odoo_project_id, date_start, date_deadline, notes, tags
            ) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,'{}')
        """, (pname, ptype, status, str(contact_id) if contact_id else None,
              proj['id'], date_start, date_end, notes))
        print(f"  + Project: {pname} [{ptype}] → {proj['partner_name'] or '—'}")

openerp.commit()

# ── Summary ────────────────────────────────────────────────────────────────────
sym_cur.execute("SELECT COUNT(*) FROM projects")
print(f"\nTotal projects: {sym_cur.fetchone()['count']}")
sym_cur.execute("SELECT COUNT(*) FROM contacts WHERE is_client = TRUE AND archived = FALSE")
print(f"Total clients: {sym_cur.fetchone()['count']}")

odoo.close()
openerp.close()
print("\nDone.")
