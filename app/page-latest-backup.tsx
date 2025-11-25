'use client'

import { useState, useEffect } from 'react'

export default function CoatingsPage() {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<any[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [specificAnswer, setSpecificAnswer] = useState<any>(null)
  const [comparisonData, setComparisonData] = useState<any>(null)
  const [analyticalData, setAnalyticalData] = useState<any>(null)
  const [hasSearched, setHasSearched] = useState(false)
  const [searchProgress, setSearchProgress] = useState('')
  const [searchTime, setSearchTime] = useState<number | null>(null)
  
  const [selectedFamily, setSelectedFamily] = useState('')
  const [selectedProductType, setSelectedProductType] = useState('')
  const [selectedProductModel, setSelectedProductModel] = useState('')
  const [showFilters, setShowFilters] = useState(false)
  
  const [familyOptions, setFamilyOptions] = useState<string[]>([])
  const [productTypeOptions, setProductTypeOptions] = useState<string[]>([])
  const [productModelOptions, setProductModelOptions] = useState<string[]>([])
  const [loadingFilters, setLoadingFilters] = useState(true)

  const [metaQuestionData, setMetaQuestionData] = useState<any>(null)

  useEffect(() => {
    loadFilterOptionsInline()
  }, [])

  // Custom Comparison Display Component with #0078a9 color
  const ComparisonDisplay = ({ summary, colorClass = 'ppg' }: { summary: string, colorClass?: string }) => {
    const colors = {
      ppg: {
        heading: 'text-[#0078a9]',
        subheading: 'text-[#0078a9]',
        text: 'text-gray-800',
        bg: 'bg-[#0078a9]/5',
        bgLight: 'bg-[#0078a9]/10',
        border: 'border-[#0078a9]',
        borderLight: 'border-[#0078a9]/30',
        badge: 'bg-[#0078a9]/10 text-[#0078a9]'
      },
      green: {
        heading: 'text-green-800',
        subheading: 'text-green-700',
        text: 'text-green-900',
        bg: 'bg-green-50',
        bgLight: 'bg-green-100',
        border: 'border-green-300',
        borderLight: 'border-green-200',
        badge: 'bg-green-100 text-green-800'
      }
    }
    
    const color = colors[colorClass as keyof typeof colors] || colors.ppg

    // Parse sections by splitting on section headers
    const parseSections = (text: string) => {
      const sectionRegex = /\*\*(Quick Summary|Key Differences|Detailed Specifications|Similarities|Use Cases|Recommendation):\*\*/gi
      const sections: { title: string; content: string }[] = []
      
      let lastIndex = 0
      let match
      const regex = new RegExp(sectionRegex)
      
      while ((match = regex.exec(text)) !== null) {
        if (lastIndex > 0) {
          const prevTitle = sections[sections.length - 1].title
          const content = text.substring(lastIndex, match.index).trim()
          sections[sections.length - 1].content = content
        }
        sections.push({ title: match[1], content: '' })
        lastIndex = regex.lastIndex
      }
      
      if (sections.length > 0) {
        sections[sections.length - 1].content = text.substring(lastIndex).trim()
      }
      
      return sections
    }

    const renderQuickSummary = (content: string) => {
      // Remove markdown formatting
      const cleanContent = content.replace(/\*\*/g, '').replace(/---/g, '').trim()
      
      return (
        <div className={`p-5 ${color.bg} rounded-xl border-l-4 ${color.border}`}>
          <p className={`${color.text} text-base leading-relaxed`}>
            {cleanContent}
          </p>
        </div>
      )
    }

    const renderKeyDifferences = (content: string) => {
      // Split by emoji indicators
      const differences = content.split(/🔹/).filter(item => item.trim())
      
      return (
        <div className="space-y-4">
          {differences.map((diff, idx) => {
            const lines = diff.trim().split('\n').filter(line => line.trim())
            if (lines.length === 0) return null
            
            // First line is the category
            const category = lines[0].replace(/\*\*/g, '').replace(/:/g, '').trim()
            
            // Remaining lines are product comparisons
            const items = lines.slice(1).filter(line => line.trim().startsWith('-') || line.includes('**'))
            
            return (
              <div key={idx} className={`p-4 rounded-lg border ${color.borderLight} hover:${color.bg} transition-colors`}>
                <h4 className={`text-lg font-semibold ${color.subheading} mb-3 flex items-center gap-2`}>
                  🔹 {category}
                </h4>
                <div className="ml-6 space-y-2">
                  {items.map((item, itemIdx) => {
                    const cleanItem = item.replace(/^-\s*/, '').trim()
                    const parts = cleanItem.split(/\*\*(.*?)\*\*:?\s*/)
                    
                    if (parts.length >= 3) {
                      return (
                        <div key={itemIdx} className="flex items-start gap-3">
                          <span className={`font-semibold ${color.badge} px-2 py-1 rounded text-sm min-w-[100px] text-center`}>
                            {parts[1]}
                          </span>
                          <span className={color.text}>{parts[2]}</span>
                        </div>
                      )
                    }
                    
                    return (
                      <div key={itemIdx} className={`${color.text} flex items-start gap-2`}>
                        <span>•</span>
                        <span dangerouslySetInnerHTML={{ __html: cleanItem.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>') }} />
                      </div>
                    )
                  })}
                </div>
              </div>
            )
          })}
        </div>
      )
    }

    const renderDetailedSpecifications = (content: string) => {
      // Split by product headers
      const productSections = content.split(/\*\*Product\s+([A-Z0-9]+)\*\*/gi)
      const products: { code: string; specs: string }[] = []
      
      for (let i = 1; i < productSections.length; i += 2) {
        products.push({
          code: productSections[i],
          specs: productSections[i + 1] || ''
        })
      }
      
      return (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {products.map((product, idx) => {
            const specs = product.specs
              .split('\n')
              .filter(line => line.trim() && line.includes('**'))
              .map(line => {
                const match = line.match(/\*\*(.*?)\*\*:?\s*(.+)/)
                if (match) {
                  return { label: match[1], value: match[2].replace(/^-\s*/, '').trim() }
                }
                return null
              })
              .filter(Boolean)
            
            return (
              <div key={idx} className={`p-6 ${color.bg} rounded-xl border-l-4 ${color.border} shadow-md`}>
                <div className="flex items-center gap-3 mb-5">
                  <span className={`${color.badge} px-4 py-2 rounded-full font-bold text-lg`}>
                    {product.code}
                  </span>
                  <h4 className={`text-xl font-bold ${color.heading}`}>
                    Product {product.code}
                  </h4>
                </div>
                <div className="space-y-3">
                  {specs.map((spec: any, specIdx: number) => (
                    <div key={specIdx} className="flex flex-col">
                      <span className={`text-sm font-semibold ${color.subheading} mb-1`}>
                        {spec.label}
                      </span>
                      <span className={`${color.text} pl-3 border-l-2 ${color.borderLight}`}>
                        {spec.value}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      )
    }

    const renderListSection = (content: string) => {
      const items = content
        .split('\n')
        .filter(line => line.trim().startsWith('-'))
        .map(line => line.replace(/^-\s*/, '').trim())
      
      return (
        <ul className="space-y-3">
          {items.map((item, idx) => (
            <li key={idx} className={`flex items-start gap-3 p-3 rounded-lg hover:${color.bg} transition-colors`}>
              <span className={`${color.subheading} mt-1`}>✓</span>
              <span 
                className={`${color.text} leading-relaxed flex-1`}
                dangerouslySetInnerHTML={{ 
                  __html: item.replace(/\*\*(.*?)\*\*/g, '<strong class="font-semibold">$1</strong>') 
                }}
              />
            </li>
          ))}
        </ul>
      )
    }

    const renderRecommendation = (content: string) => {
      const items = content
        .split('\n')
        .filter(line => line.trim().startsWith('-'))
        .map(line => line.replace(/^-\s*/, '').trim())
      
      return (
        <div className={`p-6 ${color.bg} rounded-xl border-2 ${color.border} shadow-lg`}>
          <div className="space-y-4">
            {items.map((item, idx) => {
              const parts = item.split(/\*\*(.*?)\*\*/)
              const productCode = parts[1]
              const description = parts[2] || item
              
              return (
                <div key={idx} className="flex items-start gap-4">
                  {productCode && (
                    <span className={`${color.badge} px-3 py-1 rounded-full font-bold text-sm shrink-0`}>
                      {productCode}
                    </span>
                  )}
                  <p className={`${color.text} leading-relaxed`}>
                    {description.replace(/^:\s*/, '').trim()}
                  </p>
                </div>
              )
            })}
          </div>
        </div>
      )
    }

    const sections = parseSections(summary)
    
    return (
      <div className="space-y-8">
        {sections.map((section, idx) => (
          <div key={idx} className="animate-fadeIn">
            <div className={`mb-4 pb-3 border-b-2 ${color.border}`}>
              <h3 className={`text-2xl font-bold ${color.heading} flex items-center gap-3`}>
                <span className="text-3xl">
                  {section.title === 'Quick Summary' && '📋'}
                  {section.title === 'Key Differences' && '🔍'}
                  {section.title === 'Detailed Specifications' && '📊'}
                  {section.title === 'Similarities' && '🤝'}
                  {section.title === 'Use Cases' && '💼'}
                  {section.title === 'Recommendation' && '⭐'}
                </span>
                {section.title}
              </h3>
            </div>
            <div>
              {section.title === 'Quick Summary' && renderQuickSummary(section.content)}
              {section.title === 'Key Differences' && renderKeyDifferences(section.content)}
              {section.title === 'Detailed Specifications' && renderDetailedSpecifications(section.content)}
              {section.title === 'Similarities' && renderListSection(section.content)}
              {section.title === 'Use Cases' && renderListSection(section.content)}
              {section.title === 'Recommendation' && renderRecommendation(section.content)}
            </div>
          </div>
        ))}
      </div>
    )
  }

  // Simple renderMarkdown for non-comparison content
  const renderMarkdown = (markdown: string, colorClass: string = 'ppg'): string => {
    let html = markdown
    
    const colors: { [key: string]: { heading: string; text: string; bold: string } } = {
      ppg: { heading: 'text-[#0078a9]', text: 'text-gray-800', bold: 'text-[#0078a9]' },
      green: { heading: 'text-green-800', text: 'text-green-900', bold: 'text-green-900' },
      blue: { heading: 'text-blue-800', text: 'text-blue-900', bold: 'text-blue-900' },
    }
    
    const color = colors[colorClass] || colors.ppg
    
    // Headers
    html = html.replace(/^### (.*$)/gim, `<h3 class="text-lg font-bold ${color.heading} mt-4 mb-2">$1</h3>`)
    html = html.replace(/^## (.*$)/gim, `<h2 class="text-xl font-bold ${color.heading} mt-6 mb-3">$1</h2>`)
    html = html.replace(/^# (.*$)/gim, `<h1 class="text-2xl font-bold ${color.heading} mt-8 mb-4">$1</h1>`)
    
    // Bold
    html = html.replace(/\*\*(.*?)\*\*/g, `<strong class="font-semibold ${color.bold}">$1</strong>`)
    
    // Italic
    html = html.replace(/\*(.*?)\*/g, '<em class="italic">$1</em>')
    
    // Lists
    html = html.replace(/^- (.*$)/gim, `<li class="ml-4 ${color.text}">$1</li>`)
    html = html.replace(/(<li.*?<\/li>\s*)+/gs, (match) => {
      return `<ul class="list-disc list-inside space-y-1 my-2">${match}</ul>`
    })
    
    // Line breaks
    html = html.replace(/\n\n/g, '<br/><br/>')
    html = html.replace(/\n/g, '<br/>')
    
    return html
  }

  const loadFilterOptionsInline = async () => {
    setLoadingFilters(true)
    try {
      const response = await fetch('/api/coatings-smart-search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          query: '__GET_FILTER_OPTIONS__',
          getFilterOptions: true 
        }),
      })

      if (!response.ok) {
        throw new Error('Failed to load filter options')
      }

      const data = await response.json()
      
      if (data.success && data.filterOptions) {
        setFamilyOptions(data.filterOptions.families || [])
        setProductTypeOptions(data.filterOptions.productTypes || [])
        setProductModelOptions(data.filterOptions.productModels || [])
        
        console.log('✅ Filter options loaded:', {
          families: data.filterOptions.families?.length || 0,
          types: data.filterOptions.productTypes?.length || 0,
          models: data.filterOptions.productModels?.length || 0
        })
      }
    } catch (err: any) {
      console.error('Error loading filter options:', err)
      setError('Failed to load filter options')
    } finally {
      setLoadingFilters(false)
    }
  }

  const handleSearch = async () => {
    if (!query.trim()) {
      setError('Please enter a search query')
      return
    }

    setLoading(true)
    setError('')
    setResults([])
    setSpecificAnswer(null)
    setComparisonData(null)
    setAnalyticalData(null)
    setMetaQuestionData(null)
    setHasSearched(true)
    setSearchProgress('Analyzing your question...')
    
    const startTime = Date.now()

    try {
      const filters: any = {}
      if (selectedFamily) filters.family = selectedFamily
      if (selectedProductType) filters.productType = selectedProductType
      if (selectedProductModel) filters.productModel = selectedProductModel

      setSearchProgress('Searching database...')

      const response = await fetch('/api/coatings-smart-search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          query,
          filters: Object.keys(filters).length > 0 ? filters : undefined
        }),
      })

      if (!response.ok) {
        throw new Error('Search request failed')
      }

      const data = await response.json()
      const endTime = Date.now()
      setSearchTime((endTime - startTime) / 1000)

      if (data.success) {
        setSearchProgress('Processing results...')
        
        // Handle meta-questions
        if (data.questionType === 'meta') {
          setMetaQuestionData({
            type: data.metaType,
            summary: data.summary,
            count: data.count,
            families: data.families,
            types: data.types,
            models: data.models,
            totalCount: data.totalCount,
            familyCount: data.familyCount
          })
          setResults([])
          setSearchProgress('')
          return
        }

        // Handle comparison
        if (data.questionType === 'comparison') {
          setComparisonData({
            summary: data.summary,
            products: data.results || []
          })
          setResults(data.results || [])
        }
        // Handle analytical
        else if (data.questionType === 'analytical' || data.questionType === 'specific_ai') {
          setAnalyticalData({
            summary: data.summary,
            products: data.results || []
          })
          setResults(data.results || [])
        }
        // Handle lookup
        else {
          setResults(data.results || [])
          if (data.summary) {
            setSpecificAnswer({ answer: data.summary })
          }
        }
      } else {
        setError(data.error || 'Search failed')
      }
    } catch (err: any) {
      setError(err.message || 'An error occurred during search')
      console.error('Search error:', err)
    } finally {
      setLoading(false)
      setSearchProgress('')
    }
  }

  const clearFilters = () => {
    setSelectedFamily('')
    setSelectedProductType('')
    setSelectedProductModel('')
  }

  const activeFilterCount = [selectedFamily, selectedProductType, selectedProductModel].filter(Boolean).length

  // Helper function to get all non-empty attributes
  const getAllAttributes = (product: any) => {
    const excludeKeys = ['id', 'embedding', 'vector', 'searchable_text', 'all_attributes', 'created_at', 'updated_at']
    return Object.entries(product)
      .filter(([key, value]) => 
        value && 
        value !== '' && 
        value !== null && 
        value !== undefined &&
        !excludeKeys.includes(key)
      )
      .sort(([keyA], [keyB]) => keyA.localeCompare(keyB))
  }

  // Get grid columns class based on number of products
  const getGridColumnsClass = (count: number) => {
    if (count === 1) return 'grid-cols-1'
    if (count === 2) return 'grid-cols-1 md:grid-cols-2'
    if (count === 3) return 'grid-cols-1 md:grid-cols-2 lg:grid-cols-3'
    return 'grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4'
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 via-white to-gray-50">
      <div className="container mx-auto px-4 py-8 max-w-7xl">
        {/* Header */}
        <div className="text-center mb-12">
          <h1 className="text-5xl font-bold mb-4" style={{ color: '#0078a9' }}>
            PPG Coatings Smart Search
          </h1>
          <p className="text-gray-600 text-lg">
            Ask questions about products, compare specifications, or find the perfect coating
          </p>
        </div>

        {/* Search Box */}
        <div className="bg-white rounded-2xl shadow-2xl p-8 mb-8 border border-gray-100">
          <div className="flex gap-4 mb-4">
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyPress={(e) => e.key === 'Enter' && handleSearch()}
              placeholder="Try: 'Compare 09BR007 to 09BR003' or 'What products are heat resistant?'"
              className="flex-1 px-6 py-4 text-lg border-2 border-gray-200 rounded-xl focus:outline-none focus:ring-4 transition-all"
              style={{ 
                borderColor: query ? '#0078a9' : undefined,
                '--tw-ring-color': '#0078a9'
              } as any}
              disabled={loading}
            />
            <button
              onClick={handleSearch}
              disabled={loading}
              className="px-8 py-4 text-white rounded-xl font-semibold disabled:opacity-50 disabled:cursor-not-allowed transition-all shadow-lg hover:shadow-xl"
              style={{ backgroundColor: '#0078a9' }}
              onMouseEnter={(e) => e.currentTarget.style.backgroundColor = '#005f8a'}
              onMouseLeave={(e) => e.currentTarget.style.backgroundColor = '#0078a9'}
            >
              {loading ? '🔍 Searching...' : '🔍 Search'}
            </button>
          </div>

          {/* Filters Toggle */}
          <button
            onClick={() => setShowFilters(!showFilters)}
            className="flex items-center gap-2 font-medium transition-colors"
            style={{ color: '#0078a9' }}
          >
            <span>{showFilters ? '▼' : '▶'}</span>
            <span>Advanced Filters</span>
            {activeFilterCount > 0 && (
              <span className="px-2 py-1 rounded-full text-sm font-semibold" style={{ backgroundColor: '#0078a9', opacity: 0.1, color: '#0078a9' }}>
                {activeFilterCount}
              </span>
            )}
          </button>

          {/* Filters */}
          {showFilters && (
            <div className="mt-6 p-6 bg-gray-50 rounded-xl border border-gray-200">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
                <div>
                  <label className="block text-sm font-semibold text-gray-700 mb-2">
                    Product Family
                  </label>
                  <select
                    value={selectedFamily}
                    onChange={(e) => setSelectedFamily(e.target.value)}
                    className="w-full px-4 py-2 border-2 border-gray-200 rounded-lg focus:outline-none focus:ring-2 transition-all"
                    style={{ '--tw-ring-color': '#0078a9' } as any}
                    disabled={loadingFilters}
                  >
                    <option value="">All Families</option>
                    {familyOptions.map((family) => (
                      <option key={family} value={family}>
                        {family}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-semibold text-gray-700 mb-2">
                    Product Type
                  </label>
                  <select
                    value={selectedProductType}
                    onChange={(e) => setSelectedProductType(e.target.value)}
                    className="w-full px-4 py-2 border-2 border-gray-200 rounded-lg focus:outline-none focus:ring-2 transition-all"
                    style={{ '--tw-ring-color': '#0078a9' } as any}
                    disabled={loadingFilters}
                  >
                    <option value="">All Types</option>
                    {productTypeOptions.map((type) => (
                      <option key={type} value={type}>
                        {type}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-semibold text-gray-700 mb-2">
                    Product Model
                  </label>
                  <select
                    value={selectedProductModel}
                    onChange={(e) => setSelectedProductModel(e.target.value)}
                    className="w-full px-4 py-2 border-2 border-gray-200 rounded-lg focus:outline-none focus:ring-2 transition-all"
                    style={{ '--tw-ring-color': '#0078a9' } as any}
                    disabled={loadingFilters}
                  >
                    <option value="">All Models</option>
                    {productModelOptions.map((model) => (
                      <option key={model} value={model}>
                        {model}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {activeFilterCount > 0 && (
                <button
                  onClick={clearFilters}
                  className="text-sm text-red-600 hover:text-red-700 font-medium"
                >
                  ✕ Clear all filters
                </button>
              )}
            </div>
          )}

          {/* Search Progress */}
          {searchProgress && (
            <div className="mt-4 p-4 rounded-lg border" style={{ backgroundColor: '#0078a9', opacity: 0.1, borderColor: '#0078a9' }}>
              <div className="flex items-center gap-3">
                <div className="animate-spin rounded-full h-5 w-5 border-b-2" style={{ borderColor: '#0078a9' }}></div>
                <span className="font-medium" style={{ color: '#0078a9' }}>{searchProgress}</span>
              </div>
            </div>
          )}

          {/* Error Message */}
          {error && (
            <div className="mt-4 p-4 bg-red-50 rounded-lg border border-red-200">
              <p className="text-red-700 font-medium">⚠️ {error}</p>
            </div>
          )}
        </div>

        {/* Results Section */}
        {hasSearched && !loading && (
          <div className="space-y-8">
            {/* Search Time */}
            {searchTime !== null && (
              <div className="text-center text-gray-600">
                <span className="bg-white px-4 py-2 rounded-full shadow-sm border border-gray-200">
                  ⚡ Search completed in {searchTime.toFixed(2)}s
                </span>
              </div>
            )}

            {/* Meta Question Results */}
            {metaQuestionData && (
              <div className="bg-gradient-to-br from-gray-50 to-white rounded-2xl shadow-xl p-8 border-2" style={{ borderColor: '#0078a9', opacity: 0.2 }}>
                <div className="flex items-center gap-3 mb-6">
                  <span className="text-3xl">📊</span>
                  <h2 className="text-3xl font-bold" style={{ color: '#0078a9' }}>Database Overview</h2>
                </div>
                <div
                  className="prose max-w-none"
                  dangerouslySetInnerHTML={{ __html: renderMarkdown(metaQuestionData.summary, 'ppg') }}
                />
              </div>
            )}

            {/* Comparison Results - Using Custom Component */}
            {comparisonData && (
              <div className="bg-gradient-to-br from-blue-50 to-white rounded-2xl shadow-xl p-8 border-2" style={{ borderColor: '#0078a9', opacity: 0.2 }}>
                <div className="flex items-center gap-3 mb-8">
                  <span className="text-4xl">💡</span>
                  <h2 className="text-3xl font-bold" style={{ color: '#0078a9' }}>AI Comparison Analysis</h2>
                </div>
                <ComparisonDisplay summary={comparisonData.summary} colorClass="ppg" />
              </div>
            )}

            {/* Analytical Results */}
            {analyticalData && (
              <div className="bg-gradient-to-br from-green-50 to-white rounded-2xl shadow-xl p-8 border-2 border-green-100">
                <div className="flex items-center gap-3 mb-6">
                  <span className="text-3xl">🤖</span>
                  <h2 className="text-3xl font-bold text-green-800">AI Analysis</h2>
                </div>
                <div
                  className="prose prose-green max-w-none"
                  dangerouslySetInnerHTML={{ __html: renderMarkdown(analyticalData.summary, 'green') }}
                />
              </div>
            )}

            {/* Specific Answer */}
            {specificAnswer && !comparisonData && !analyticalData && (
              <div className="bg-gradient-to-br from-blue-50 to-white rounded-2xl shadow-xl p-8 border-2" style={{ borderColor: '#0078a9', opacity: 0.2 }}>
                <div className="flex items-center gap-3 mb-6">
                  <span className="text-3xl">💬</span>
                  <h2 className="text-3xl font-bold" style={{ color: '#0078a9' }}>Answer</h2>
                </div>
                <div
                  className="prose max-w-none"
                  dangerouslySetInnerHTML={{ __html: renderMarkdown(specificAnswer.answer, 'ppg') }}
                />
              </div>
            )}

            {/* Product Cards */}
            {results.length > 0 && (
              <div>
                <div className="flex items-center justify-between mb-6">
                  <h2 className="text-2xl font-bold text-gray-800">
                    📦 Products Found ({results.length})
                  </h2>
                </div>

                <div className={`grid ${getGridColumnsClass(results.length)} gap-6`}>
                  {results.map((product, index) => {
                    const attributes = getAllAttributes(product)
                    
                    return (
                      <div
                        key={index}
                        className="bg-white rounded-xl shadow-lg hover:shadow-2xl transition-all duration-300 border border-gray-100 overflow-hidden group"
                      >
                        {/* Product Header */}
                        <div className="p-6 text-white" style={{ backgroundColor: '#0078a9' }}>
                          <div className="flex items-start justify-between mb-2">
                            <h3 className="text-2xl font-bold">{product.sku || 'N/A'}</h3>
                            <span className="bg-white/20 px-3 py-1 rounded-full text-sm font-semibold">
                              #{index + 1}
                            </span>
                          </div>
                          {product.Product_Name && (
                            <p className="text-blue-100 text-sm font-medium">
                              {product.Product_Name}
                            </p>
                          )}
                        </div>

                        {/* Product Details */}
                        <div className="p-6">
                          <div className="space-y-3 max-h-96 overflow-y-auto">
                            {attributes.map(([key, value]) => (
                              <div
                                key={key}
                                className="flex flex-col pb-3 border-b border-gray-100 last:border-0"
                              >
                                <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">
                                  {key.replace(/_/g, ' ')}
                                </span>
                                <span className="text-gray-800 font-medium">
                                  {String(value)}
                                </span>
                              </div>
                            ))}
                          </div>
                        </div>

                        {/* Product Footer */}
                        <div className="px-6 py-4 bg-gray-50 border-t border-gray-100">
                          <div className="flex items-center justify-between text-sm">
                            <span className="text-gray-600">
                              {attributes.length} attributes
                            </span>
                            {product.family && (
                              <span className="px-3 py-1 rounded-full font-semibold" style={{ backgroundColor: '#0078a9', opacity: 0.1, color: '#0078a9' }}>
                                {product.family}
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}

            {/* No Results */}
            {results.length === 0 && !metaQuestionData && !comparisonData && !analyticalData && !specificAnswer && (
              <div className="text-center py-16">
                <div className="text-6xl mb-4">🔍</div>
                <h3 className="text-2xl font-bold text-gray-700 mb-2">No Results Found</h3>
                <p className="text-gray-600">
                  Try adjusting your search query or filters
                </p>
              </div>
            )}
          </div>
        )}

        {/* Example Queries */}
        {!hasSearched && (
          <div className="bg-white rounded-2xl shadow-xl p-8 border border-gray-100">
            <h3 className="text-2xl font-bold text-gray-800 mb-6">💡 Try These Example Queries</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {[
                'Compare 09BR007 to 09BR003',
                'What products are heat resistant?',
                'Show me all DESOTHANE products',
                'Which coatings work best for aircraft?',
                'What is the shelf life of 09BR007?',
                'List all polyurethane topcoats'
              ].map((example, idx) => (
                <button
                  key={idx}
                  onClick={() => setQuery(example)}
                  className="text-left p-4 rounded-xl transition-all border border-gray-200 group"
                  style={{ backgroundColor: '#0078a9', opacity: 0.05 }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.backgroundColor = '#0078a9'
                    e.currentTarget.style.opacity = '0.1'
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.backgroundColor = '#0078a9'
                    e.currentTarget.style.opacity = '0.05'
                  }}
                >
                  <span className="text-gray-700 group-hover:font-medium">
                    "{example}"
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Add custom animations */}
      <style jsx>{`
        @keyframes fadeIn {
          from {
            opacity: 0;
            transform: translateY(10px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
        .animate-fadeIn {
          animation: fadeIn 0.5s ease-out;
        }
      `}</style>
    </div>
  )
}
