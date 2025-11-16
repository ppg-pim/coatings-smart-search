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

  useEffect(() => {
    loadFilterOptionsInline()
  }, [])

  const loadFilterOptionsInline = async () => {
    setLoadingFilters(true)
    try {
      const response = await fetch('/api/coatings-smart-search', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ 
          query: '__GET_FILTER_OPTIONS__',
          getFilterOptions: true
        }),
      })
      
      if (response.ok) {
        const data = await response.json()
        if (data.filterOptions) {
          setFamilyOptions(data.filterOptions.families || [])
          setProductTypeOptions(data.filterOptions.productTypes || [])
          setProductModelOptions(data.filterOptions.productModels || [])
          console.log('✅ Loaded coatings filter options:', data.filterOptions)
        }
      } else {
        console.error('Failed to load coatings filter options:', response.status)
      }
    } catch (err) {
      console.error('Failed to load coatings filter options:', err)
    } finally {
      setLoadingFilters(false)
    }
  }

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError('')
    setResults([])
    setSpecificAnswer(null)
    setComparisonData(null)
    setAnalyticalData(null)
    setHasSearched(true)
    setSearchProgress('Analyzing your query...')
    setSearchTime(null)

    const startTime = Date.now()

    try {
      setSearchProgress('Searching database...')
      
      const response = await fetch('/api/coatings-smart-search', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ 
          query,
          family: selectedFamily,
          productType: selectedProductType,
          productModel: selectedProductModel
        }),
      })

      const data = await response.json()
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
      setSearchTime(parseFloat(elapsed))

      if (!response.ok) {
        throw new Error(data.error || 'Search failed')
      }

      setSearchProgress('Processing results...')

      // Handle different response types
      if (data.questionType === 'analytical') {
        setAnalyticalData(data)
        setResults(data.products || [])
      }
      else if (data.questionType === 'comparison') {
        setComparisonData(data)
        setResults(data.products || [])
      }
      else if (data.questionType === 'specific') {
        setSpecificAnswer(data)
        if (data.fullProduct) {
          setResults([data.fullProduct])
        }
      }
      else if (data.questionType === 'meta') {
        setAnalyticalData(data)
        setResults([])
      }
      else {
        setResults(data.products || [])
      }
    } catch (err: any) {
      setError(err.message)
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

  const hasActiveFilters = selectedFamily || selectedProductType || selectedProductModel

  const isEmpty = (value: any): boolean => {
    if (value === null || value === undefined) return true
    if (typeof value === 'string' && value.trim() === '') return true
    if (Array.isArray(value) && value.length === 0) return true
    return false
  }

  const groupAttributes = (product: any) => {
    const headerFields = ['sku', 'name', 'product_name', 'productname', 'description', 'product_description']
    const excludeFields = ['embedding', 'created_at', 'updated_at', 'createdat', 'updatedat', 'searchable_text', 'searchabletext', 'searchable', '_sourceTable']
    
    const header: any = {}
    const other: any = {}
    const seen = new Set<string>()

    Object.entries(product).forEach(([key, value]) => {
      const lowerKey = key.toLowerCase()
      
      if (seen.has(lowerKey) || excludeFields.includes(lowerKey) || isEmpty(value)) return
      seen.add(lowerKey)
      
      if (headerFields.includes(lowerKey)) {
        header[key] = value
      } else {
        other[key] = value
      }
    })

    return { header, other }
  }

  const formatFieldName = (key: string): string => {
    const fieldMappings: { [key: string]: string } = {
      'sku': 'SKU',
      'product_name': 'Product Name',
      'productname': 'Product Name',
      'product_description': 'Description',
      'product_model': 'Product Model',
      'productmodel': 'Product Model',
      'product_type': 'Product Type',
      'producttype': 'Product Type',
    }
    
    const lowerKey = key.toLowerCase()
    if (fieldMappings[lowerKey]) {
      return fieldMappings[lowerKey]
    }
    
    return key
      .replace(/_/g, ' ')
      .replace(/\b\w/g, (char) => char.toUpperCase())
  }

  const formatValue = (key: string, value: any): string => {
    const lowerKey = key.toLowerCase()
    if ((lowerKey.includes('created') || lowerKey.includes('updated')) && 
        typeof value === 'string' && value.includes('T')) {
      try {
        return new Date(value).toLocaleString()
      } catch {
        return String(value)
      }
    }
    return String(value)
  }

  const getAllKeys = (products: any[]) => {
    const allKeys = new Set<string>()
    const seenLowerKeys = new Set<string>()
    const excludeFields = ['embedding', 'created_at', 'updated_at', 'createdat', 'updatedat', 'searchable_text', 'searchabletext', '_sourceTable']
    
    products.forEach(product => {
      Object.keys(product).forEach(key => {
        const lowerKey = key.toLowerCase()
        if (!seenLowerKeys.has(lowerKey) && !excludeFields.includes(lowerKey) && !isEmpty(product[key])) {
          allKeys.add(key)
          seenLowerKeys.add(lowerKey)
        }
      })
    })
    return Array.from(allKeys)
  }

  const isDifferent = (key: string, products: any[]) => {
    const values = products.map(p => p[key])
    return new Set(values).size > 1
  }

  const scrollToProducts = () => {
    const element = document.getElementById('product-references')
    if (element) {
      element.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }

  const renderAnalyticalSummary = () => {
    if (!analyticalData) return null

    return (
      <div className="mb-8">
        <div className="bg-gradient-to-r from-green-50 to-emerald-50 border-l-4 border-green-500 rounded-lg overflow-hidden shadow-lg">
          <div className="p-6">
            <div className="flex items-start mb-4">
              <div className="flex-shrink-0">
                <svg className="h-8 w-8 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                </svg>
              </div>
              <div className="ml-4 flex-1">
                <h2 className="text-2xl font-bold text-green-900 mb-2">AI Analysis</h2>
                <p className="text-green-700 text-sm">
                  Based on analysis of {analyticalData.count} coating product(s)
                  {searchTime && <span className="ml-2">• Completed in {searchTime}s</span>}
                </p>
              </div>
            </div>
            
            <div className="prose prose-green max-w-none">
              <div 
                className="text-gray-800 leading-relaxed whitespace-pre-wrap"
                dangerouslySetInnerHTML={{ 
                  __html: analyticalData.summary
                    .replace(/\*\*(.*?)\*\*/g, '<strong class="text-green-900">$1</strong>')
                    .replace(/\n\n/g, '</p><p class="mt-4">')
                    .replace(/^/, '<p>')
                    .replace(/$/, '</p>')
                    .replace(/• /g, '<li class="ml-4">')
                    .replace(/<\/p><p class="mt-4"><li/g, '</p><ul class="list-disc ml-6 mt-2 space-y-1"><li')
                    .replace(/<li class="ml-4">(.*?)<\/p>/g, '<li class="ml-4">$1</li></ul><p class="mt-4">')
                }}
              />
            </div>
          </div>
        </div>

        {analyticalData.count > 0 && (
          <div className="mt-6 bg-blue-50 border border-blue-200 rounded-lg p-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center">
                <svg className="h-5 w-5 text-blue-600 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <span className="text-sm font-medium text-blue-900">
                  {analyticalData.count} coating product reference{analyticalData.count !== 1 ? 's' : ''} available below
                </span>
              </div>
              <button
                onClick={scrollToProducts}
                className="relative z-10 text-sm font-medium text-blue-600 hover:text-blue-800 hover:underline focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 rounded px-3 py-1 transition-all cursor-pointer"
                type="button"
              >
                View Details →
              </button>
            </div>
          </div>
        )}
      </div>
    )
  }

  const renderMetaSummary = () => {
    if (!analyticalData || analyticalData.questionType !== 'meta') return null

    return (
      <div className="mb-8">
        <div className="bg-gradient-to-r from-indigo-50 to-purple-50 border-l-4 border-indigo-500 rounded-lg overflow-hidden shadow-lg">
          <div className="p-6">
            <div className="flex items-start mb-4">
              <div className="flex-shrink-0">
                <svg className="h-8 w-8 text-indigo-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
                </svg>
              </div>
              <div className="ml-4 flex-1">
                <h2 className="text-2xl font-bold text-indigo-900 mb-2">Database Information</h2>
                <p className="text-indigo-700 text-sm">
                  {analyticalData.metaType === 'count' && 'Product count summary'}
                  {analyticalData.metaType === 'list' && 'Available product categories'}
                  {analyticalData.metaType === 'overview' && 'Complete database overview'}
                  {searchTime && <span className="ml-2">• Retrieved in {searchTime}s</span>}
                </p>
              </div>
            </div>
            
            <div className="prose prose-indigo max-w-none">
              <div 
                className="text-gray-800 leading-relaxed whitespace-pre-wrap"
                dangerouslySetInnerHTML={{ 
                  __html: analyticalData.summary
                    .replace(/\*\*(.*?)\*\*/g, '<strong class="text-indigo-900">$1</strong>')
                    .replace(/### (.*?)(\n|$)/g, '<h3 class="text-lg font-bold text-indigo-900 mt-4 mb-2">$1</h3>')
                    .replace(/## (.*?)(\n|$)/g, '<h2 class="text-xl font-bold text-indigo-900 mt-4 mb-2">$1</h2>')
                    .replace(/\n\n/g, '</p><p class="mt-4">')
                    .replace(/^/, '<p>')
                    .replace(/$/, '</p>')
                    .replace(/• /g, '<li class="ml-4">')
                    .replace(/<\/p><p class="mt-4"><li/g, '</p><ul class="list-disc ml-6 mt-2 space-y-1"><li')
                    .replace(/<li class="ml-4">(.*?)(?=<\/p>|<p|$)/g, '<li class="ml-4">$1</li>')
                    .replace(/(<\/li>)\s*<p/g, '$1</ul><p')
                }}
              />
            </div>
          </div>
        </div>
      </div>
    )
  }

  const renderComparison = () => {
    if (!comparisonData || !comparisonData.products || comparisonData.products.length < 2) {
      return null
    }

    const products = comparisonData.products
    const allKeys = getAllKeys(products)
    
    const priorityFields = ['sku', 'product_name', 'productname', 'name', 'description', 'product_description']
    
    const priority = allKeys.filter(k => priorityFields.includes(k.toLowerCase()))
    const technical = allKeys.filter(k => !priorityFields.includes(k.toLowerCase()))

    return (
      <div className="mb-8">
        <div className="mb-6 bg-gradient-to-r from-blue-50 to-indigo-50 border-l-4 border-blue-500 p-6 rounded-lg">
          <h2 className="text-2xl font-bold text-blue-900 mb-2">Coating Product Comparison</h2>
          <p className="text-blue-700">
            Comparing {products.length} coating products - Differences are highlighted
            {searchTime && <span className="ml-2">• Completed in {searchTime}s</span>}
          </p>
        </div>

        {/* AI Comparison Summary */}
        {comparisonData.summary && (
          <div className="mb-6 bg-gradient-to-r from-purple-50 to-pink-50 border-l-4 border-purple-500 rounded-lg overflow-hidden shadow-lg">
            <div className="p-6">
              <div className="flex items-start mb-4">
                <div className="flex-shrink-0">
                  <svg className="h-8 w-8 text-purple-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                  </svg>
                </div>
                <div className="ml-4 flex-1">
                  <h3 className="text-xl font-bold text-purple-900 mb-2">AI Comparison Analysis</h3>
                  <p className="text-purple-700 text-sm">
                    Detailed comparison of {products.length} products
                  </p>
                </div>
              </div>
              
              <div className="prose prose-purple max-w-none">
                <div 
                  className="text-gray-800 leading-relaxed whitespace-pre-wrap"
                  dangerouslySetInnerHTML={{ 
                    __html: comparisonData.summary
                      .replace(/\*\*(.*?)\*\*/g, '<strong class="text-purple-900">$1</strong>')
                      .replace(/### (.*?)(\n|$)/g, '<h3 class="text-lg font-bold text-purple-900 mt-4 mb-2">$1</h3>')
                      .replace(/## (.*?)(\n|$)/g, '<h2 class="text-xl font-bold text-purple-900 mt-4 mb-2">$1</h2>')
                      .replace(/# (.*?)(\n|$)/g, '<h1 class="text-2xl font-bold text-purple-900 mt-4 mb-2">$1</h1>')
                      .replace(/\n\n/g, '</p><p class="mt-3">')
                      .replace(/^(?!<h[123]|<p)/, '<p>')
                      .replace(/(?<!<\/h[123]>)$/g, '</p>')
                      .replace(/\n- /g, '<li class="ml-4">')
                      .replace(/<\/p>\s*<li/g, '</p><ul class="list-disc ml-6 mt-2 space-y-1 mb-3"><li')
                      .replace(/<li class="ml-4">(.*?)(?=<\/p>|<p|$)/g, '<li class="ml-4">$1</li>')
                      .replace(/(<li.*?<\/li>)\s*<p/g, '$1</ul><p')
                  }}
                />
              </div>
            </div>
          </div>
        )}

        {/* Comparison Table */}
        <div className="bg-white rounded-lg shadow-lg overflow-hidden border border-gray-200">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="bg-gray-50 border-b-2 border-gray-200">
                  <th className="px-6 py-4 text-left text-sm font-semibold text-gray-700 w-1/4 sticky left-0 bg-gray-50 z-10">
                    Attribute
                  </th>
                  {products.map((product: any, idx: number) => (
                    <th 
                      key={idx} 
                      className="px-6 py-4 text-left text-sm font-semibold"
                      style={{ color: '#0078a9' }}
                    >
                      <div className="font-bold">{product.sku || product.Product_Name || `Product ${idx + 1}`}</div>
                      {product.family && (
                        <div className="text-xs font-normal text-gray-600 mt-1">Family: {product.family}</div>
                      )}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {priority.map((key) => {
                  const different = isDifferent(key, products)
                  return (
                    <tr 
                      key={key} 
                      className={`border-b border-gray-200 ${different ? 'bg-yellow-50' : 'hover:bg-gray-50'}`}
                    >
                      <td className="px-6 py-4 text-sm font-semibold text-gray-700 sticky left-0 bg-white z-10">
                        <div className="flex items-center gap-2">
                          {formatFieldName(key)}
                          {different && (
                            <span className="inline-block w-2 h-2 bg-yellow-500 rounded-full" title="Different values"></span>
                          )}
                        </div>
                      </td>
                      {products.map((product: any, idx: number) => (
                        <td 
                          key={idx} 
                          className={`px-6 py-4 text-sm text-gray-900 ${different ? 'font-semibold' : ''}`}
                        >
                          {formatValue(key, product[key]) || '-'}
                        </td>
                      ))}
                    </tr>
                  )
                })}

                {technical.length > 0 && (
                  <>
                    <tr className="bg-gray-100">
                      <td colSpan={products.length + 1} className="px-6 py-3 text-xs font-bold uppercase tracking-wide" style={{ color: '#0078a9' }}>
                        Technical Specifications
                      </td>
                    </tr>

                    {technical.map((key) => {
                      const different = isDifferent(key, products)
                      return (
                        <tr 
                          key={key} 
                          className={`border-b border-gray-200 ${different ? 'bg-yellow-50' : 'hover:bg-gray-50'}`}
                        >
                          <td className="px-6 py-3 text-sm text-gray-700 sticky left-0 bg-white z-10">
                            <div className="flex items-center gap-2">
                              {formatFieldName(key)}
                              {different && (
                                <span className="inline-block w-2 h-2 bg-yellow-500 rounded-full" title="Different values"></span>
                              )}
                            </div>
                          </td>
                          {products.map((product: any, idx: number) => (
                            <td 
                              key={idx} 
                              className={`px-6 py-3 text-sm text-gray-900 ${different ? 'font-semibold' : ''}`}
                            >
                              {formatValue(key, product[key]) || '-'}
                            </td>
                          ))}
                        </tr>
                      )
                    })}
                  </>
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="mt-4 flex items-center gap-2 text-sm text-gray-600">
          <span className="inline-block w-3 h-3 bg-yellow-50 border border-yellow-200 rounded"></span>
          <span>Highlighted rows indicate differences between coating products</span>
        </div>
      </div>
    )
  }

  return (
    <main className="min-h-screen p-8 max-w-7xl mx-auto bg-gray-50">
      <div className="bg-white rounded-lg shadow-sm p-8 mb-8">
        <h1 className="text-4xl font-bold mb-2 text-center" style={{ color: '#0078a9' }}>
          Coatings Smart Search
        </h1>
        <p className="text-center text-gray-600 mb-8">
          Search coating products using natural language • Powered by AI
        </p>

        <form onSubmit={handleSearch}>
          <div className="flex gap-4 mb-4">
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Ask anything... (e.g., 'Best coating for corrosion protection', 'Compare primer options', 'Tell me about 02GN093')"
              className="flex-1 px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#0078a9] focus:border-transparent"
            />
            <button
              type="button"
              onClick={() => setShowFilters(!showFilters)}
              className="px-6 py-3 border-2 rounded-lg font-medium transition-colors"
              style={{ 
                borderColor: '#0078a9',
                color: showFilters ? '#fff' : '#0078a9',
                backgroundColor: showFilters ? '#0078a9' : 'transparent'
              }}
            >
              <svg className="w-5 h-5 inline-block mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" />
              </svg>
              Filters
              {hasActiveFilters && (
                <span className="ml-2 inline-flex items-center justify-center w-5 h-5 text-xs font-bold text-white bg-red-500 rounded-full">
                  {[selectedFamily, selectedProductType, selectedProductModel].filter(Boolean).length}
                </span>
              )}
            </button>
            <button
              type="submit"
              disabled={loading || !query.trim()}
              className="px-8 py-3 text-white rounded-lg hover:opacity-90 disabled:bg-gray-400 disabled:cursor-not-allowed font-medium transition-colors"
              style={{ backgroundColor: '#0078a9' }}
            >
              {loading ? 'Searching...' : 'Search'}
            </button>
          </div>

          {showFilters && (
            <div className="border border-gray-200 rounded-lg p-6 bg-gray-50">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-semibold" style={{ color: '#0078a9' }}>
                  Filter Options {loadingFilters && <span className="text-sm font-normal text-gray-500">(Loading...)</span>}
                </h3>
                {hasActiveFilters && (
                  <button
                    type="button"
                    onClick={clearFilters}
                    className="text-sm text-red-600 hover:text-red-800 font-medium"
                  >
                    Clear All Filters
                  </button>
                )}
              </div>
              
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Family ({familyOptions.length} options)
                  </label>
                  <select
                    value={selectedFamily}
                    onChange={(e) => setSelectedFamily(e.target.value)}
                    disabled={loadingFilters}
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#0078a9] focus:border-transparent disabled:bg-gray-100"
                  >
                    <option value="">All Families</option>
                    {familyOptions.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Product Type ({productTypeOptions.length} options)
                  </label>
                  <select
                    value={selectedProductType}
                    onChange={(e) => setSelectedProductType(e.target.value)}
                    disabled={loadingFilters}
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#0078a9] focus:border-transparent disabled:bg-gray-100"
                  >
                    <option value="">All Types</option>
                    {productTypeOptions.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Product Model ({productModelOptions.length} options)
                  </label>
                  <select
                    value={selectedProductModel}
                    onChange={(e) => setSelectedProductModel(e.target.value)}
                    disabled={loadingFilters}
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#0078a9] focus:border-transparent disabled:bg-gray-100"
                  >
                    <option value="">All Models</option>
                    {productModelOptions.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {hasActiveFilters && (
                <div className="mt-4 flex flex-wrap gap-2">
                  <span className="text-sm text-gray-600">Active filters:</span>
                  {selectedFamily && (
                    <span className="inline-flex items-center px-3 py-1 rounded-full text-sm font-medium bg-blue-100 text-blue-800">
                      Family: {selectedFamily}
                      <button
                        type="button"
                        onClick={() => setSelectedFamily('')}
                        className="ml-2 text-blue-600 hover:text-blue-800"
                      >
                        ×
                      </button>
                    </span>
                  )}
                  {selectedProductType && (
                    <span className="inline-flex items-center px-3 py-1 rounded-full text-sm font-medium bg-green-100 text-green-800">
                      Type: {selectedProductType}
                      <button
                        type="button"
                        onClick={() => setSelectedProductType('')}
                        className="ml-2 text-green-600 hover:text-green-800"
                      >
                        ×
                      </button>
                    </span>
                  )}
                  {selectedProductModel && (
                    <span className="inline-flex items-center px-3 py-1 rounded-full text-sm font-medium bg-purple-100 text-purple-800">
                      Model: {selectedProductModel}
                      <button
                        type="button"
                        onClick={() => setSelectedProductModel('')}
                        className="ml-2 text-purple-600 hover:text-purple-800"
                      >
                        ×
                      </button>
                    </span>
                  )}
                </div>
              )}
            </div>
          )}
        </form>
      </div>

      {loading && (
        <div className="text-center py-12 bg-white rounded-lg border border-gray-200 shadow-sm">
          <div className="inline-block animate-spin rounded-full h-12 w-12 border-b-2 border-[#0078a9] mb-4"></div>
          <p className="text-lg font-medium text-gray-700">Searching coating products...</p>
          {searchProgress && (
            <p className="mt-2 text-sm text-gray-600">{searchProgress}</p>
          )}
          <p className="mt-2 text-xs text-gray-400">Optimized search • Typically completes in 2-5 seconds</p>
        </div>
      )}

      {error && (
        <div className="bg-red-50 border-l-4 border-red-500 p-6 rounded-lg shadow-sm">
          <div className="flex items-center">
            <svg className="h-6 w-6 text-red-500 mr-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <div>
              <h3 className="text-lg font-semibold text-red-800">Search Error</h3>
              <p className="text-red-700 mt-1">{error}</p>
            </div>
          </div>
        </div>
      )}

      {!loading && !error && hasSearched && (
        <>
          {renderMetaSummary()}
          {renderAnalyticalSummary()}
          {renderComparison()}

          {results.length > 0 && !comparisonData && (
            <div id="product-references" className="bg-white rounded-lg shadow-sm p-6">
              <div className="flex items-center justify-between mb-6">
                <h2 className="text-2xl font-bold" style={{ color: '#0078a9' }}>
                  {analyticalData ? 'Product References' : 'Search Results'}
                </h2>
                <div className="flex items-center gap-4">
                  {searchTime && (
                    <span className="text-sm text-gray-500">
                      ⚡ {searchTime}s
                    </span>
                  )}
                  <span className="px-4 py-2 bg-blue-100 text-blue-800 rounded-full text-sm font-semibold">
                    {results.length} {results.length === 1 ? 'Product' : 'Products'}
                  </span>
                </div>
              </div>

              <div className="space-y-6">
                {results.map((product, index) => {
                  const { header, other } = groupAttributes(product)
                  
                  return (
                    <div 
                      key={index} 
                      className="border border-gray-200 rounded-lg p-6 hover:shadow-md transition-shadow bg-gray-50"
                    >
                      <div className="mb-4 pb-4 border-b border-gray-300">
                        {Object.entries(header).map(([key, value]) => (
                          <div key={key} className="mb-2">
                            <span className="font-bold text-lg" style={{ color: '#0078a9' }}>
                              {formatFieldName(key)}:
                            </span>
                            <span className="ml-2 text-gray-800 text-lg">
                              {formatValue(key, value)}
                            </span>
                          </div>
                        ))}
                        {product._sourceTable && (
                          <div className="mt-2">
                            <span className="inline-block px-3 py-1 bg-purple-100 text-purple-800 rounded-full text-xs font-semibold">
                              Found in: {product._sourceTable}
                            </span>
                          </div>
                        )}
                      </div>

                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        {Object.entries(other).map(([key, value]) => (
                          <div key={key} className="flex flex-col">
                            <span className="text-sm font-semibold text-gray-600 mb-1">
                              {formatFieldName(key)}
                            </span>
                            <span className="text-sm text-gray-800 bg-white p-2 rounded border border-gray-200">
                              {formatValue(key, value)}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {!loading && !error && hasSearched && results.length === 0 && !analyticalData && (
            <div className="text-center py-12 bg-white rounded-lg border border-gray-200 shadow-sm">
              <svg className="mx-auto h-16 w-16 text-gray-400 mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.172 16.172a4 4 0 015.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <h3 className="text-xl font-semibold text-gray-700 mb-2">No Products Found</h3>
              <p className="text-gray-600 mb-4">
                We couldn&apos;t find any coating products matching your search.
              </p>
              <p className="text-sm text-gray-500">
                Try adjusting your search terms or filters, or browse all products.
              </p>
            </div>
          )}
        </>
      )}
    </main>
  )
}
