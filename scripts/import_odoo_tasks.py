#!/usr/bin/env python3
"""Import Odoo project tasks into openerp project_tasks table."""
import re
import os
import psycopg2
import psycopg2.extras

ODOO_DSN  = os.environ.get("ODOO_DSN", "host=localhost port=5432 dbname=odoo user=odoo password=")
OPENERP_DSN = "host=172.22.0.4 port=5432 dbname=openerp user=openerp password=EnoHammock3413!"

def strip_html(t):
    if not t: return None
    t = re.sub(r'<[^>]+>', ' ', t)
    t = re.sub(r'&nbsp;', ' ', t)
    t = re.sub(r'&amp;', '&', t)
    t = re.sub(r'\s+', ' ', t).strip()
    return t or None

def extract(v):
    if isinstance(v, dict): return v.get('en_US') or next(iter(v.values()), None)
    m = re.search(r'["\']en_US["\']\s*:\s*["\']([^"\']*)["\']', str(v))
    return m.group(1) if m else str(v)

odoo   = psycopg2.connect(ODOO_DSN)
openerp = psycopg2.connect(OPENERP_DSN)
oc = odoo.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
sc = openerp.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
sw = openerp.cursor()

# Odoo project_id → openerp project_id
sc.execute("SELECT project_id, odoo_project_id FROM projects WHERE odoo_project_id IS NOT NULL")
proj_map = {r['odoo_project_id']: r['project_id'] for r in sc.fetchall()}

STATE_MAP = {
    '01_in_progress': 'in_progress',
    '1_done':         'done',
    '1_canceled':     'canceled',
    '03_approved':    'done',
    '04_wait_normal': 'blocked',
}

oc.execute("""
    SELECT pt.id, pt.name, pt.project_id as odoo_project_id,
           pts.name as stage_name, pt.state,
           pt.date_deadline, pt.description, pt.active
    FROM project_task pt
    LEFT JOIN project_task_type pts ON pts.id = pt.stage_id
    WHERE pt.active = TRUE AND pt.project_id IS NOT NULL
    ORDER BY pt.project_id, pt.id
""")
tasks = oc.fetchall()
print(f"Odoo tasks: {len(tasks)}")

inserted = updated = skipped = 0
for t in tasks:
    pid = proj_map.get(t['odoo_project_id'])
    if not pid:
        skipped += 1
        continue

    stage = extract(t['stage_name']) if t['stage_name'] else None
    state = STATE_MAP.get(t['state'], t['state'])
    is_done = state in ('done',)
    desc = strip_html(t['description'])
    deadline = t['date_deadline']

    sc.execute("SELECT task_id FROM project_tasks WHERE odoo_task_id = %s", (t['id'],))
    existing = sc.fetchone()
    if existing:
        sw.execute("""
            UPDATE project_tasks SET name=%s, stage=%s, state=%s, is_done=%s,
                date_deadline=%s, description=%s, updated_at=NOW()
            WHERE odoo_task_id=%s
        """, (t['name'], stage, state, is_done, deadline, desc, t['id']))
        updated += 1
    else:
        sw.execute("""
            INSERT INTO project_tasks (project_id, odoo_task_id, name, stage, state,
                is_done, date_deadline, description)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s)
        """, (str(pid), t['id'], t['name'], stage, state, is_done, deadline, desc))
        inserted += 1

openerp.commit()
print(f"Inserted: {inserted}, Updated: {updated}, Skipped (no project match): {skipped}")
sc.execute("SELECT COUNT(*) FROM project_tasks")
print(f"Total tasks: {sc.fetchone()['count']}")
odoo.close(); openerp.close()
print("Done.")
