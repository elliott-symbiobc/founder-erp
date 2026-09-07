import Link from "next/link";

export const metadata = { title: "End User License Agreement — Open ERP" };

export default function EulaPage() {
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
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">End User License Agreement</h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">Last updated: April 8, 2026</p>
        </div>

        <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm p-8 prose prose-sm dark:prose-invert max-w-none text-gray-700 dark:text-gray-300 space-y-6">

          <section>
            <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-2">1. Agreement to Terms</h2>
            <p>This End User License Agreement (&ldquo;Agreement&rdquo;) is a legal agreement between you (&ldquo;User&rdquo;) and Your Company LLC (&ldquo;Open ERP,&rdquo; &ldquo;we,&rdquo; &ldquo;our,&rdquo; or &ldquo;us&rdquo;) governing your access to and use of the Open ERP platform (the &ldquo;Platform&rdquo;). By accessing or using the Platform, you agree to be bound by this Agreement. If you do not agree, do not access or use the Platform.</p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-2">2. License Grant</h2>
            <p>Subject to the terms of this Agreement, Open ERP grants you a limited, non-exclusive, non-transferable, revocable license to access and use the Platform solely for your authorized internal business purposes. This license does not include the right to sublicense, resell, or otherwise transfer access to the Platform to any third party.</p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-2">3. Access and Account Security</h2>
            <p>Access to the Platform is granted by Open ERP administrators. You are responsible for maintaining the confidentiality of your login credentials and for all activities that occur under your account. You agree to notify Open ERP immediately of any unauthorized use of your account. Open ERP reserves the right to terminate or suspend access at any time, with or without cause.</p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-2">4. Permitted Use</h2>
            <p>You may use the Platform only for lawful purposes and in accordance with this Agreement. You agree not to:</p>
            <ul className="list-disc pl-5 space-y-1 mt-2">
              <li>Copy, modify, distribute, sell, or lease any part of the Platform or its underlying software;</li>
              <li>Reverse engineer, decompile, or attempt to extract the source code of the Platform;</li>
              <li>Use the Platform to transmit harmful, offensive, or unlawful content;</li>
              <li>Attempt to gain unauthorized access to any part of the Platform or its connected systems;</li>
              <li>Use automated tools to scrape, index, or harvest data from the Platform without prior written consent.</li>
            </ul>
          </section>

          <section>
            <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-2">5. Intellectual Property</h2>
            <p>The Platform and all content, features, and functionality therein — including but not limited to software, algorithms, models, text, graphics, and data — are and remain the exclusive property of Your Company LLC and its licensors. Nothing in this Agreement transfers any intellectual property rights to you.</p>
            <p className="mt-2">Data you upload or generate through your use of the Platform remains your property. You grant Open ERP a limited license to use such data solely for the purpose of providing and improving the Platform.</p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-2">6. Confidentiality</h2>
            <p>The Platform may provide access to confidential business information, research data, financial models, and proprietary analyses. You agree to keep all such information strictly confidential and not to disclose it to any third party without prior written authorization from Open ERP.</p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-2">7. Disclaimer of Warranties</h2>
            <p>THE PLATFORM IS PROVIDED &ldquo;AS IS&rdquo; AND &ldquo;AS AVAILABLE&rdquo; WITHOUT WARRANTIES OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, OR NON-INFRINGEMENT. OPEN ERP DOES NOT WARRANT THAT THE PLATFORM WILL BE UNINTERRUPTED, ERROR-FREE, OR FREE OF VIRUSES OR OTHER HARMFUL COMPONENTS.</p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-2">8. Limitation of Liability</h2>
            <p>TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, OPEN ERP SHALL NOT BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES, INCLUDING LOSS OF PROFITS, DATA, OR GOODWILL, ARISING OUT OF OR IN CONNECTION WITH YOUR USE OF OR INABILITY TO USE THE PLATFORM, EVEN IF OPEN ERP HAS BEEN ADVISED OF THE POSSIBILITY OF SUCH DAMAGES. OPEN ERP&rsquo;S TOTAL CUMULATIVE LIABILITY TO YOU SHALL NOT EXCEED THE AMOUNTS PAID BY YOU TO OPEN ERP IN THE TWELVE (12) MONTHS PRECEDING THE CLAIM.</p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-2">9. Termination</h2>
            <p>This Agreement is effective until terminated. Open ERP may terminate your access immediately and without notice if you breach any term of this Agreement. Upon termination, you must cease all use of the Platform. Sections 5, 6, 7, 8, and 10 survive termination.</p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-2">10. Governing Law</h2>
            <p>This Agreement shall be governed by and construed in accordance with the laws of the State of Delaware, without regard to its conflict of law provisions. Any dispute arising out of or related to this Agreement shall be subject to the exclusive jurisdiction of the courts located in Delaware.</p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-2">11. Changes to This Agreement</h2>
            <p>Open ERP reserves the right to modify this Agreement at any time. We will notify users of material changes by updating the &ldquo;Last updated&rdquo; date above. Continued use of the Platform after changes take effect constitutes acceptance of the revised Agreement.</p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-2">12. Contact</h2>
            <p>For questions about this Agreement, contact us at <a href="mailto:legal@example.com" className="text-blue-600 dark:text-blue-400 hover:underline">legal@example.com</a>.</p>
          </section>
        </div>

        <p className="mt-6 text-center text-xs text-gray-400 dark:text-gray-500">
          &copy; {new Date().getFullYear()} Your Company LLC. All rights reserved. &nbsp;·&nbsp;
          <Link href="/privacy" className="hover:underline">Privacy Policy</Link>
        </p>
      </div>
    </div>
  );
}
