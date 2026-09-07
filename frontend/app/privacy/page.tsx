import Link from "next/link";

export const metadata = { title: "Privacy Policy — Open ERP" };

export default function PrivacyPage() {
  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950 px-4 py-12">
      <div className="max-w-3xl mx-auto">
        {/* Header */}
        <div className="mb-8">
          <Link href="/login" className="text-sm text-blue-600 dark:text-blue-400 hover:underline">
            ← Back to Sign In
          </Link>
          <div className="mt-6 mb-2">
            <span className="text-xl font-semibold tracking-tight text-gray-900 dark:text-gray-100">Open ERP</span>
          </div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Privacy Policy</h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">Last updated: April 8, 2026</p>
        </div>

        <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm p-8 text-gray-700 dark:text-gray-300 space-y-6">

          <section>
            <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-2">1. Introduction</h2>
            <p>Your Company LLC (&ldquo;Open ERP,&rdquo; &ldquo;we,&rdquo; &ldquo;our,&rdquo; or &ldquo;us&rdquo;) operates the Open ERP platform (the &ldquo;Platform&rdquo;). This Privacy Policy explains how we collect, use, disclose, and safeguard information when you access or use the Platform. Please read this policy carefully. If you disagree with its terms, please discontinue use of the Platform.</p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-2">2. Information We Collect</h2>
            <p className="font-medium text-gray-800 dark:text-gray-200 mt-3 mb-1">2.1 Information You Provide</p>
            <ul className="list-disc pl-5 space-y-1">
              <li><span className="font-medium">Account information:</span> Name, email address, and password when your account is created by an administrator.</li>
              <li><span className="font-medium">Operational data:</span> Project records, contact and CRM data, financial model inputs, and other content you enter into the Platform.</li>
              <li><span className="font-medium">Communications:</span> Any messages or feedback you submit to us.</li>
            </ul>
            <p className="font-medium text-gray-800 dark:text-gray-200 mt-3 mb-1">2.2 Information Collected Automatically</p>
            <ul className="list-disc pl-5 space-y-1">
              <li><span className="font-medium">Log data:</span> IP address, browser type, pages visited, time and date of access, and referring URLs.</li>
              <li><span className="font-medium">Session data:</span> Authentication tokens and session identifiers used to maintain your logged-in state.</li>
              <li><span className="font-medium">Usage data:</span> Feature interactions and navigation patterns used to improve the Platform.</li>
            </ul>
            <p className="font-medium text-gray-800 dark:text-gray-200 mt-3 mb-1">2.3 Third-Party Integrations</p>
            <p>The Platform may integrate with third-party services including financial data providers (Plaid) and accounting software (QuickBooks Online). When you authorize such integrations, we receive data from those services as described in their respective privacy policies. We use that data solely to provide the features you requested.</p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-2">3. How We Use Your Information</h2>
            <p>We use the information we collect to:</p>
            <ul className="list-disc pl-5 space-y-1 mt-2">
              <li>Provide, operate, and maintain the Platform;</li>
              <li>Authenticate users and protect account security;</li>
              <li>Process and display research, operational, and financial data you input;</li>
              <li>Generate analyses, reports, and recommendations within the Platform;</li>
              <li>Improve and develop new features based on usage patterns;</li>
              <li>Communicate with you about Platform updates, security notices, or support matters;</li>
              <li>Comply with applicable legal obligations.</li>
            </ul>
            <p className="mt-2">We do not sell, rent, or trade your personal information to third parties for their marketing purposes.</p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-2">4. Data Retention</h2>
            <p>We retain your information for as long as your account is active or as needed to provide the Platform&rsquo;s services. Research data, financial models, and operational records are retained in accordance with Open ERP&rsquo;s internal data governance policies. You may request deletion of your account and associated personal data by contacting us at <a href="mailto:privacy@example.com" className="text-blue-600 dark:text-blue-400 hover:underline">privacy@example.com</a>. Note that certain data may be retained where required by law or legitimate business necessity.</p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-2">5. Data Security</h2>
            <p>We implement industry-standard technical and organizational measures to protect your information against unauthorized access, alteration, disclosure, or destruction. These include encrypted data transmission (TLS), access controls, authentication requirements, and regular security reviews. However, no method of transmission over the Internet or electronic storage is completely secure, and we cannot guarantee absolute security.</p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-2">6. Disclosure of Information</h2>
            <p>We may disclose your information in the following limited circumstances:</p>
            <ul className="list-disc pl-5 space-y-1 mt-2">
              <li><span className="font-medium">Service providers:</span> To trusted vendors who assist us in operating the Platform (e.g., cloud hosting, AI services), under confidentiality obligations;</li>
              <li><span className="font-medium">Legal requirements:</span> When required by law, court order, or government authority;</li>
              <li><span className="font-medium">Business transfers:</span> In connection with a merger, acquisition, or sale of assets, with appropriate confidentiality protections;</li>
              <li><span className="font-medium">Protection of rights:</span> To protect the rights, safety, or property of Open ERP, its users, or others.</li>
            </ul>
          </section>

          <section>
            <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-2">7. AI and Automated Processing</h2>
            <p>The Platform uses AI models (including Anthropic&rsquo;s Claude) to generate research insights, composition analyses, and recommendations. Data you input may be processed by these AI systems as part of the Platform&rsquo;s core functionality. We do not use your data to train third-party AI models beyond what is required to provide the service. AI-generated outputs are provided for informational purposes and should be reviewed by qualified professionals before acting on them.</p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-2">8. Your Rights</h2>
            <p>Depending on your jurisdiction, you may have the right to:</p>
            <ul className="list-disc pl-5 space-y-1 mt-2">
              <li>Access the personal information we hold about you;</li>
              <li>Request correction of inaccurate data;</li>
              <li>Request deletion of your personal data;</li>
              <li>Object to or restrict certain processing activities;</li>
              <li>Data portability where technically feasible.</li>
            </ul>
            <p className="mt-2">To exercise any of these rights, contact us at <a href="mailto:privacy@example.com" className="text-blue-600 dark:text-blue-400 hover:underline">privacy@example.com</a>. We will respond within 30 days.</p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-2">9. Cookies and Tracking</h2>
            <p>The Platform uses session cookies necessary for authentication and maintaining your logged-in state. We do not use third-party advertising cookies or cross-site tracking technologies. You may configure your browser to refuse cookies, but doing so may prevent you from using the Platform.</p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-2">10. Children&rsquo;s Privacy</h2>
            <p>The Platform is not directed at individuals under the age of 18. We do not knowingly collect personal information from minors. If you believe a minor has provided us with personal information, please contact us and we will take steps to delete it.</p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-2">11. Changes to This Policy</h2>
            <p>We may update this Privacy Policy from time to time. We will notify users of material changes by updating the &ldquo;Last updated&rdquo; date above. Your continued use of the Platform after changes take effect constitutes acceptance of the revised policy.</p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-2">12. Contact Us</h2>
            <p>For questions, concerns, or requests related to this Privacy Policy, please contact:</p>
            <div className="mt-2 text-sm">
              <p className="font-medium text-gray-800 dark:text-gray-200">Your Company LLC</p>
              <p><a href="mailto:privacy@example.com" className="text-blue-600 dark:text-blue-400 hover:underline">privacy@example.com</a></p>
            </div>
          </section>
        </div>

        <p className="mt-6 text-center text-xs text-gray-400 dark:text-gray-500">
          &copy; {new Date().getFullYear()} Your Company LLC. All rights reserved. &nbsp;·&nbsp;
          <Link href="/eula" className="hover:underline">EULA</Link>
        </p>
      </div>
    </div>
  );
}
