#!/usr/bin/env python3
"""
Import/sync contacts from Odoo into openerp DB.
- Matches existing contacts by email or name
- Inserts missing ones
- Marks is_client based on customer_rank > 0
- Sets odoo_id for future deduplication
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
    clean = re.sub(r'&lt;', '<', clean)
    clean = re.sub(r'&gt;', '>', clean)
    clean = re.sub(r'\s+', ' ', clean).strip()
    return clean or None

odoo = psycopg2.connect(ODOO_DSN)
openerp = psycopg2.connect(OPENERP_DSN)

odoo_cur = odoo.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
sym_cur = openerp.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

# Fetch all top-level active contacts from Odoo
odoo_cur.execute("""
    SELECT
        rp.id,
        rp.name,
        rp.email,
        rp.phone,
        rp.website,
        rp.is_company,
        rp.customer_rank,
        rp.function as job_title,
        rp.comment as notes
    FROM res_partner rp
    WHERE rp.active = TRUE
      AND (rp.type = 'contact' OR rp.type IS NULL OR rp.type = '')
      AND rp.parent_id IS NULL
      AND rp.name NOT ILIKE 'Administrator%%'
      AND rp.name NOT ILIKE 'Public%%'
      AND rp.name NOT ILIKE 'OdooBot%%'
    ORDER BY rp.name
""")
odoo_contacts = odoo_cur.fetchall()
print(f"Odoo contacts to process: {len(odoo_contacts)}")

# Build lookup maps of existing openerp contacts
sym_cur.execute("SELECT contact_id, name, email, odoo_id FROM contacts WHERE archived = FALSE")
existing = sym_cur.fetchall()
by_odoo_id = {r['odoo_id']: r for r in existing if r['odoo_id']}
by_email = {r['email'].lower(): r for r in existing if r['email']}
by_name = {r['name'].lower(): r for r in existing}

inserted = 0
updated = 0

sym_write = openerp.cursor()

for oc in odoo_contacts:
    odoo_id = oc['id']
    name = oc['name']
    email = oc['email']
    is_client = (oc['customer_rank'] or 0) > 0
    notes = strip_html(oc['notes'])
    organization = name if oc['is_company'] else None

    # Try to find existing match
    existing_row = None
    if odoo_id in by_odoo_id:
        existing_row = by_odoo_id[odoo_id]
    elif email and email.lower() in by_email:
        existing_row = by_email[email.lower()]
    elif name.lower() in by_name:
        existing_row = by_name[name.lower()]

    if existing_row:
        sym_write.execute("""
            UPDATE contacts SET
                odoo_id = %s,
                is_client = %s,
                updated_at = NOW()
            WHERE contact_id = %s
        """, (odoo_id, is_client, existing_row['contact_id']))
        updated += 1
    else:
        sym_write.execute("""
            INSERT INTO contacts (
                name, email, phone, organization, title,
                website_url, notes, odoo_id, is_client,
                tags, subject_areas
            ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, '{}', '{}')
        """, (
            name,
            email or None,
            oc['phone'] or None,
            organization,
            oc['job_title'] or None,
            oc['website'] or None,
            notes,
            odoo_id,
            is_client,
        ))
        inserted += 1
        print(f"  + Inserted: {name} (client={is_client})")

openerp.commit()

print(f"\nDone. Inserted: {inserted}, Updated/matched: {updated}")

sym_cur.execute("SELECT COUNT(*) FROM contacts WHERE is_client = TRUE AND archived = FALSE")
print(f"Total clients in openerp: {sym_cur.fetchone()['count']}")

sym_cur.execute("SELECT COUNT(*) FROM contacts WHERE archived = FALSE")
print(f"Total contacts in openerp: {sym_cur.fetchone()['count']}")

odoo.close()
openerp.close()
