import { H1, H2, H3, P, Lead, Ul, Ol, Li, Tip, Warning, Concept, SimpleTable } from "../_components";

export default function AgentLayerPage() {
  return (
    <article>
      <H1>The Literature Agent</H1>
      <Lead>
        The literature agent automatically monitors scientific databases for new Aspergillus
        fermentation papers, extracts structured data, and stages it for human review before
        it enters the training set. It is how the model learns from published science without
        manual data entry.
      </Lead>

      <H2>What It Does</H2>
      <P>Every Monday at 02:00, the agent:</P>
      <Ol>
        <Li>Queries OpenAlex and Semantic Scholar for papers published in the past 7 days matching Aspergillus fermentation search terms.</Li>
        <Li>For each paper with an accessible abstract or full text, sends the text to Claude with a structured extraction prompt asking for: strain name, substrate, enzyme titer, titer unit, fermentation conditions (temperature, pH, duration), and an evidence quote — the exact sentence the data was read from.</Li>
        <Li>Runs the extracted strain and substrate names through the fuzzy matcher to find the closest registry entry.</Li>
        <Li>Stages all results in the review queue with status <em>pending</em>. Nothing enters the training data until you explicitly approve it.</Li>
      </Ol>

      <Concept>
        No data enters the ML model without your explicit approval. The extraction agent makes
        mistakes — unit ambiguity, fuzzy strain names, optimistic claims in abstracts. The
        review queue is the quality gate between automated extraction and model training.
      </Concept>

      <H2>Why Human Review Is Required</H2>
      <P>
        Automated extraction from scientific literature has several failure modes that require
        human judgement:
      </P>
      <SimpleTable
        headers={["Failure mode", "Example", "How to catch it"]}
        rows={[
          ["Unit ambiguity", "Paper reports 1347 U/L using a non-standard assay definition", "Check titer unit chip. If flagged 'unit ambiguous', verify assay method in the evidence quote against your internal assay."],
          ["Strain alias", "Paper says 'Aspergillus oryzae ATCC 22788' — an alias for RIB40", "Check strain match confidence bar. If below 80%, verify the alias manually before approving."],
          ["Overclaiming", "Abstract claims highest reported titer; methods section shows single replicate with no error bars", "Read the evidence quote. Single replicates from non-peer-reviewed sources get reduced weight."],
          ["Condition mismatch", "Titer achieved under optimised conditions not reproducible in your lab (e.g. 48-hr liquid culture vs 5-day SSF)", "Check fermentation type chip (SSF vs SmF) and temperature. Flag for notes if conditions are very different from your protocol."],
          ["Non-target enzyme", "Paper measures cellulase activity but you're targeting xylanase", "Check enzyme class chip. If not your target enzyme class, reject rather than approving."],
        ]}
      />

      <H2>How to Review Queue Items</H2>
      <P>
        Each queue card has two modes. <strong>View mode</strong> shows the extracted data and
        source information. <strong>Edit mode</strong> (click the pencil icon) lets you correct
        entity matches, titer values, and add notes before approving.
      </P>

      <H3>Check the routing indicator first</H3>
      <P>
        Every queue card shows a routing indicator that tells you exactly where the data will go
        if you approve it. Check this before reviewing the rest of the record.
      </P>
      <SimpleTable
        headers={["Indicator colour", "Destination", "What it means"]}
        rows={[
          ["Green — Will add to ML training set", "fermentation_runs table", "Strain is matched to a registry entry with CAZyme annotation. Data counts toward the 30-run threshold."],
          ["Blue — Will add to biological prior library", "species_level_observations table", "Strain is species-level only, unmatched, or not yet genome-annotated. Improves TEA calibration but does not train the ML model."],
          ["Red — Cannot approve", "Blocked", "No titer value is present. Switch to edit mode and add a titer before approving."],
        ]}
      />
      <P>
        The routing indicator updates live as you edit. If you correct an unmatched strain to a
        registry entry that has CAZyme annotation, the indicator changes from blue to green.
      </P>

      <H3>Review checklist</H3>
      <Ol>
        <Li>
          <strong>Read the evidence quote.</strong> This is the exact sentence or passage Claude
          extracted the data from. If the quote doesn't clearly state the titer value shown,
          reject the item.
        </Li>
        <Li>
          <strong>Check the DOI / source link.</strong> Click through to the paper. The evidence
          quote should appear verbatim in the source. If the paper is paywalled and extraction
          came only from the abstract, apply more scrutiny.
        </Li>
        <Li>
          <strong>Check strain match tier.</strong> Matches are graded: exact match (100%) ·
          known alias (≥95%) · fuzzy match ≥80% (confirm before approving) · fuzzy match 50–79%
          (amber — verify manually) · unmatched (must select from picker or create new strain).
          In edit mode you can search the full registry and select the correct entry.
        </Li>
        <Li>
          <strong>Check substrate match.</strong> Same process as strain. Substrate names in
          literature are often generic ("rice straw", "wheat bran"). Match to your registry
          entry if an equivalent exists. If no match, you can create a new substrate from the
          picker.
        </Li>
        <Li>
          <strong>Check titer value and unit.</strong> Confirm the number matches the evidence
          quote. Standard units (U/mL, U/g, g/L) are accepted directly. Non-standard units
          (IU, FPU, mm halo diameter) require manual conversion or explicit unit selection in
          edit mode.
        </Li>
        <Li>
          <strong>Check source flags.</strong> Preprint items have not been peer-reviewed.
          Patent items may describe idealised conditions. Both can still be approved, but apply
          more scrutiny.
        </Li>
        <Li>
          <strong>Approve or reject.</strong> Approve if the data is real, entities are correctly
          matched, and the conditions are comparable to your system. Reject if anything is
          ambiguous — it is better to lose a marginal data point than to corrupt the training set.
        </Li>
      </Ol>
      <Warning>
        A rejected item is archived, not deleted. If you later find that a rejected item should
        have been approved, contact Elliott to recover it from the archive.
      </Warning>

      <H2>What Happens on Approval</H2>
      <P>
        Clicking Approve triggers a PostgreSQL database function that inserts the record directly
        into the fermentation runs table and updates the training dataset view. The insertion
        happens atomically — either the full record is inserted or nothing is, with no partial
        states.
      </P>
      <P>
        If the training set now has 30 or more rows, XGBoost retraining runs automatically at
        03:00 the following morning. The dashboard Model stat will update to reflect the new
        training row count. The model version number increments after each successful retrain.
      </P>

      <H2>Uploading Papers Manually</H2>
      <P>
        The queue page has an <strong>Upload Paper</strong> button. Use this to extract data
        from papers you already have — partner publications, conference proceedings, or papers
        that didn't appear in the weekly sweep.
      </P>
      <Ol>
        <Li>Click <strong>Upload Paper</strong> and select a PDF file.</Li>
        <Li>The system extracts selectable text from the PDF. The first 8,000 characters are sent to Claude with the extraction prompt.</Li>
        <Li>Claude extracts all strain × substrate × titer combinations it finds in the text.</Li>
        <Li>Extracted records are staged in the queue immediately with source <em>Upload</em> and follow the same review process as automated extractions.</Li>
      </Ol>
      <Warning>
        The PDF must contain a selectable text layer. Scanned image PDFs (where the text is
        a photograph) cannot be parsed and will return a "could not extract text" error. Use
        the publisher's HTML or a text-layer PDF instead. Most PDFs from publishers published
        after 2005 are machine-readable.
      </Warning>
      <Tip>
        If a paper contains multiple experiments (different temperatures, strains, or substrates),
        the agent will extract each one as a separate queue item. Review each independently —
        the best conditions from a paper are usually the most relevant to approve.
      </Tip>
      <P>
        If the upload completes but shows "0 data points found", the paper does not report
        fermentation titers in numeric form in the text — data may be in figures only, or the
        paper may report qualitative results. In this case, log the run manually from the Runs
        page using the paper as your source.
      </P>

      <H2>Calibration Suggestions</H2>
      <P>
        When a species-level observation is approved, the system compares the extracted titer
        against the current TEA default for that enzyme class and organism. If the difference
        exceeds 20%, a calibration suggestion is generated and appears on the Model Health page.
      </P>
      <P>
        Each calibration suggestion shows the enzyme class, the observed titer from literature,
        the current TEA default, and the suggested update direction. Elliott reviews and approves
        or rejects each suggestion. Approved suggestions update the TEA titer defaults, which
        immediately affects MPSP calculations for substrates with no measured lab data.
      </P>
      <Warning>
        Titers reported in activity units (U/mL) always require manual review before a calibration
        default is updated, because activity unit values are assay-specific and not directly
        comparable across labs. Only mass-based titers (g/L) are applied automatically.
      </Warning>
      <Tip>
        Calibration suggestions are never applied automatically — they require explicit approval
        to prevent a single outlier paper from silently shifting all commercial projections.
      </Tip>

      <H2>Fuzzy Matching and Alias Resolution</H2>
      <P>
        The fuzzy matcher uses RapidFuzz string similarity to match extracted names against the
        strain and substrate registries. It knows common aliases — for example:
      </P>
      <SimpleTable
        headers={["Alias in literature", "Resolved to"]}
        rows={[
          ["A. oryzae RIB40", "A. oryzae RIB40 (canonical)"],
          ["IAM 2640", "A. oryzae RIB40"],
          ["NBRC 100959", "A. oryzae RIB40"],
          ["ATCC 42149", "A. oryzae RIB40"],
          ["Aspergillus niger ATCC 1015", "A. niger ATCC 1015 (canonical)"],
          ["An ATCC 1015", "A. niger ATCC 1015"],
        ]}
      />
      <P>
        Matches below 80% confidence are flagged with an amber bar and the unmatched chip,
        requiring manual confirmation before approval. The entity picker in the queue card lets
        you search the full registry and select the correct entry. If the strain is genuinely
        new to the registry, you can create it directly from the picker and optionally provide
        an NCBI accession to trigger genome annotation.
      </P>
    </article>
  );
}
